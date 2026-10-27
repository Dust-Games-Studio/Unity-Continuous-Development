import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import {
  isUnsupportedCommand,
  unityLicenseActivate,
  unityLicenseReturn,
} from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';
import { unityBaseOptions } from './setup.js';

/**
 * What the licence step did, so the logs and `summary.json` can say whether a
 * seat was taken. `activated` is false only for `license.mode: none` — every
 * activation mode either activates or throws.
 */
export interface LicenseActivation {
  activated: boolean;
  mode: string;
}

/**
 * The outcome of a teardown attempt.
 *
 * `returnLicense` never throws, so this result is how a caller tells a released
 * seat from a held one. The **run lifecycle** logs it and ignores it for the
 * exit code (GC9); the **standalone** `unityci license return` command turns
 * `returned: false` into exit 6, because a user who explicitly asked for a seat
 * to be returned must not be told it succeeded when it did not.
 *
 * `returned` and `seatLeaked` answer different questions. `returned` is "did the
 * CLI release a seat?"; `seatLeaked` is "is a seat still held after this call?".
 * For an offline `--file` licence both can be true: `unity license return`
 * exits 0 and leaves the licence in place, so the CLI reports success while the
 * runner still holds a seat that must be reclaimed by hand (R17). It is set on
 * every result — `false` for every other mode — so `summary.json` can surface
 * the leak without distinguishing "not applicable" from "not recorded".
 *
 * `code` is Unity's exit code, or `EXIT.COMMAND_FAILED` when the call could not
 * run at all (a spawn failure, a thrown exception).
 */
export interface LicenseReturnResult {
  returned: boolean;
  code: number;
  error?: string;
  /** `license.mode: offline-file`: the CLI leaves the licence in place. */
  seatLeaked?: boolean;
}

/**
 * A configuration/precondition failure in the licence lifecycle. The command
 * layer prints the message and exits `exitCode` instead of letting the error
 * escape as an internal error (R17: a licence failure is 64, never retryable).
 */
export class LicenseError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.CONFIG_ERROR) {
    super(message);
    this.name = 'LicenseError';
    this.exitCode = exitCode;
  }
}

/**
 * How long the teardown may take (GC9). Short on purpose: a slow licensing
 * service must not hold the job open, and a failure here never masks the
 * primary exit code anyway.
 */
export const LICENSE_RETURN_TIMEOUT_MS = 60_000;

/**
 * Reads a secret from the context's environment, falling back to the process
 * environment. `ctx.env` is the process environment in the real CLI, but a
 * caller (or a test) may pass a narrower set; the child inherits
 * `process.env` either way, so both sources are honoured.
 *
 * The value is trimmed. A CI secret written by `echo … >> $GITHUB_ENV` (or
 * pasted from a file) commonly carries a trailing newline: passing it on would
 * make `unity license activate` reject the serial, and registering the padded
 * form would leave the redactor unable to match the bare serial that Unity
 * echoes back.
 */
function secretValue(ctx: CoreContext, name: string): string | null {
  const value = ctx.env[name] ?? process.env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The secret exactly as the environment holds it, for redaction only.
 *
 * A base64 value written by a CI secret file can be line-wrapped: trimming
 * removes the surrounding newlines but not the internal ones, so a reformatted
 * echo of the blob contains the raw form while a bare echo contains the trimmed
 * one. Both must be registered (GC6).
 */
function rawSecretValue(ctx: CoreContext, name: string): string | null {
  const value = ctx.env[name] ?? process.env[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Registers a secret with the redactor, turning a broken redactor into a
 * controlled configuration failure instead of an escaping exception (R17). If
 * the secret cannot be masked, proceeding would risk printing it, so the
 * activation stops at 64.
 */
function registerSecret(ctx: CoreContext, value: string | null): void {
  // A whitespace-only value (a half-written CI secret file holding just "\n")
  // would otherwise become a redaction pattern and mask every newline in every
  // later log line of the process. Only a value with real content is a secret.
  if (value === null || value.trim() === '') return;
  try {
    ctx.redactor.register(value);
  } catch {
    throw new LicenseError(
      'could not register a license secret with the redactor; refusing to continue rather than risk printing it.',
      EXIT.CONFIG_ERROR,
    );
  }
}

/** A description of an arbitrary rejection value; never throws. */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    try {
      return error.message;
    } catch {
      return 'unknown error';
    }
  }
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * Redacts through the context, falling back to a fixed marker rather than
 * throwing. Printing the unredacted value would be worse than losing detail.
 */
function safeRedact(ctx: CoreContext, value: string): string {
  try {
    return ctx.redactor.redact(value);
  } catch {
    return '<redaction failed>';
  }
}

/**
 * Logs without letting a broken sink (a closed stdout, a throwing custom
 * logger) break the licence lifecycle. A teardown that throws while reporting
 * a failure is worse than one that reports nothing (GC9).
 */
function safeLog(
  ctx: CoreContext,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  try {
    ctx.logger[level](message);
  } catch {
    // Deliberately swallowed: see the doc comment.
  }
}

/** The base options for one licence child, with an explicit env override. */
function licenseBaseOptions(
  ctx: CoreContext,
  overrides: NodeJS.ProcessEnv = {},
  timeoutMs?: number,
): ReturnType<typeof unityBaseOptions> {
  const base = unityBaseOptions(ctx);
  return { ...base, env: { ...base.env, ...overrides }, timeoutMs };
}

/** One `errors[]` entry as text, tolerating the unvalidated child envelope. */
function errorText(entry: unknown): string {
  if (typeof entry !== 'object' || entry === null) return '';
  const record = entry as { code?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (code !== '' && message !== '') return `${code}: ${message}`;
  return message !== '' ? message : code;
}

/** A one-line description of a failed `unity` call, for a log/error message. */
function failureDetail(result: UnityResult): string {
  // `result.json` is parsed from Unity's raw stdout and is not validated: a
  // third-party CLI may put a string where an array belongs. Guard the shape
  // here so a malformed envelope becomes a controlled 64, not a TypeError.
  const raw: unknown = result.json?.errors;
  const errors = (Array.isArray(raw) ? raw : [])
    .map(errorText)
    .filter((value) => value !== '');
  if (errors.length > 0) return `: ${errors.join('; ')}`;

  const firstLine = (result.stderr || result.stdout).split(/\r?\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  return trimmed === '' ? '' : `: ${trimmed}`;
}

/** A successful activation, from the CLI's exit code and envelope. */
function activationSucceeded(result: UnityResult): boolean {
  return result.code === 0 && result.json?.success !== false;
}

/**
 * Throws the one error type the command layer maps to an exit code. The detail
 * is redacted here as well as in the logger, so a value Unity echoes back can
 * never ride along on an exception that someone later prints.
 */
function activationFailure(
  ctx: CoreContext,
  mode: string,
  result: UnityResult,
): never {
  if (isUnsupportedCommand(result)) {
    throw new LicenseError(
      'this Unity CLI does not support `license activate`; the toolkit cannot activate a license with this CLI.',
      EXIT.CONFIG_ERROR,
    );
  }
  // Unity's CLI exits 4 when `--floating` has no server to talk to. Name the
  // cause and the one setting that fixes it: the endpoint lives in the
  // machine's `licensingServiceBaseUrl`, and there is deliberately no
  // UNITY_LICENSING_SERVER environment variable to point at.
  if (mode === 'floating' && result.code === EXIT.NEEDS_CONFIG) {
    throw new LicenseError(
      '`unity license activate --floating` failed (exit 4): no floating license server is configured on this machine. ' +
        'Set the CLI\'s `licensingServiceBaseUrl` to your server; there is no UNITY_LICENSING_SERVER environment variable.' +
        safeRedact(ctx, failureDetail(result)),
      EXIT.CONFIG_ERROR,
    );
  }
  throw new LicenseError(
    `\`unity license activate\` failed for license.mode "${mode}" (exit ${result.code})` +
      safeRedact(ctx, failureDetail(result)),
    EXIT.CONFIG_ERROR,
  );
}

/** Decodes the base64 secret into an owner-only `.ulf` and activates with it. */
async function activateFromFile(
  ctx: CoreContext,
  encoded: string,
): Promise<LicenseActivation> {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0) {
    throw new LicenseError(
      `${ctx.config.license.fileEnv} does not contain a base64-encoded license file (it decoded to zero bytes).`,
      EXIT.CONFIG_ERROR,
    );
  }

  // A private directory, so the file name is not guessable by another user on
  // the same runner, and a `.ulf` suffix because the CLI dispatches on it.
  let directory: string;
  try {
    directory = mkdtempSync(join(tmpdir(), 'unityci-license-'));
  } catch (error) {
    throw new LicenseError(
      `could not create a temporary directory for the offline license file: ${describeThrown(error)}.`,
      EXIT.CONFIG_ERROR,
    );
  }
  const path = join(directory, 'license.ulf');

  try {
    try {
      writeFileSync(path, bytes, { mode: 0o600 });
      // The umask can only clear bits, but be explicit: on POSIX the licence
      // material is readable by its owner and nobody else (NTFS ACLs are not
      // governed by this mode).
      chmodSync(path, 0o600);
    } catch (error) {
      throw new LicenseError(
        `could not write the temporary offline license file ${path}: ${describeThrown(error)}.`,
        EXIT.CONFIG_ERROR,
      );
    }

    // An operational fact, not a footnote: `unity license return` leaves an
    // offline licence in place, so this runner's seat must be reclaimed by
    // hand (R17).
    safeLog(
      ctx,
      'warn',
      'an offline `--file` license cannot be returned by `unity license return`; this runner leaks a seat that must be reclaimed by hand.',
    );

    const result = await unityLicenseActivate(licenseBaseOptions(ctx), ['--file', path]);
    if (!activationSucceeded(result)) activationFailure(ctx, 'offline-file', result);

    safeLog(
      ctx,
      'info',
      'Unity license activated from the offline license file (mode "offline-file").',
    );
    return { activated: true, mode: 'offline-file' };
  } finally {
    // A cleanup failure must not replace the activation result (or the
    // LicenseError) with an internal error. On Windows the Unity child or an
    // antivirus scanner can still hold the file; say so and move on.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      safeLog(
        ctx,
        'warn',
        `could not delete the temporary offline license file at ${path}: ${describeThrown(error)}. ` +
          'It contains license material and may remain on this runner; delete it by hand.',
      );
    }
  }
}

/**
 * Activates a Unity licence according to `license.mode`, or reports that none
 * is needed. Secrets travel through the environment only (GC5):
 *
 * - `serial`: `unity license activate` is called with **no** `--serial` flag.
 *   The core reads the value from `config.license.serialEnv`, then exports it to
 *   the child under **`UNITY_LICENSE_SERIAL`** (the name Unity's CLI actually
 *   reads) and under the configured name as well. The serial never appears in
 *   any child's `argv`.
 * - `floating`: `--floating`; the endpoint comes from the machine's
 *   `licensingServiceBaseUrl`, not from an environment variable (there is no
 *   `UNITY_LICENSING_SERVER`).
 * - `offline-file`: the base64 value named by `config.license.fileEnv` is
 *   decoded to an owner-only temporary `.ulf`, passed with `--file`, and
 *   deleted in a `finally`.
 * - `personal`: `--personal --accept-eula`, **local only**. Unity's licensing
 *   backend rejects service-account tokens for activation, so this route
 *   cannot work in CI (S1). It exists for a developer machine.
 *
 * Every secret is registered with the redactor before the first log line that
 * could contain it (GC6). A failure is a configuration error (64), never a
 * retryable one (R17).
 */
export async function activateLicense(ctx: CoreContext): Promise<LicenseActivation> {
  const mode = ctx.config.license.mode;

  switch (mode) {
    case 'none':
      safeLog(
        ctx,
        'info',
        'license.mode is "none": no activation is performed; an active license is a precondition of the run.',
      );
      return { activated: false, mode };

    case 'serial': {
      const name = ctx.config.license.serialEnv;
      const serial = secretValue(ctx, name);
      // Register before anything is logged, whatever the outcome (GC6).
      registerSecret(ctx, serial);
      if (serial === null) {
        throw new LicenseError(
          `license.mode is "serial" but the environment variable ${name} is empty or unset. ` +
            'Set it in the environment (never in unity-ci.yml or on a command line).',
          EXIT.CONFIG_ERROR,
        );
      }

      safeLog(
        ctx,
        'info',
        `activating a Unity license with the serial from ${name} (the core exports it to the CLI as UNITY_LICENSE_SERIAL; it is never placed on the command line).`,
      );
      const result = await unityLicenseActivate(
        licenseBaseOptions(ctx, {
          // Unity's CLI reads this exact name, whatever the config calls the
          // source variable.
          UNITY_LICENSE_SERIAL: serial,
          // Keep the configured name meaningful in the child environment too,
          // for diagnostics and for a child that prefers it.
          [name]: serial,
        }),
        [],
      );
      if (!activationSucceeded(result)) activationFailure(ctx, mode, result);

      safeLog(ctx, 'info', 'Unity license activated (mode "serial").');
      return { activated: true, mode };
    }

    case 'floating': {
      safeLog(
        ctx,
        'info',
        "activating a Unity license with the floating server configured on this machine (`licensingServiceBaseUrl`).",
      );
      const result = await unityLicenseActivate(licenseBaseOptions(ctx), ['--floating']);
      if (!activationSucceeded(result)) activationFailure(ctx, mode, result);

      safeLog(ctx, 'info', 'Unity license activated (mode "floating").');
      return { activated: true, mode };
    }

    case 'offline-file': {
      const name = ctx.config.license.fileEnv;
      const raw = rawSecretValue(ctx, name);
      const encoded = secretValue(ctx, name);
      // Register before anything is logged, whatever the outcome (GC6). Both
      // forms: the raw one matches a line-wrapped echo, the trimmed one a bare
      // echo.
      registerSecret(ctx, raw);
      registerSecret(ctx, encoded);
      if (encoded === null) {
        throw new LicenseError(
          `license.mode is "offline-file" but the environment variable ${name} is empty or unset. ` +
            'It must hold the base64-encoded contents of a .ulf license file.',
          EXIT.CONFIG_ERROR,
        );
      }

      return await activateFromFile(ctx, encoded);
    }

    case 'personal':
      safeLog(
        ctx,
        'warn',
        'license.mode is "personal": this route is local-only. Unity\'s licensing backend rejects service-account tokens for activation, so `--personal` cannot work in CI.',
      );
      {
        const result = await unityLicenseActivate(licenseBaseOptions(ctx), [
          '--personal',
          '--accept-eula',
        ]);
        if (!activationSucceeded(result)) activationFailure(ctx, mode, result);
      }

      safeLog(ctx, 'info', 'Unity license activated (mode "personal").');
      return { activated: true, mode };

    default: {
      // Config validation rejects any other value; this guards a hand-built
      // context at runtime.
      const unknown: never = mode;
      throw new LicenseError(
        `unknown license.mode ${JSON.stringify(unknown)}; expected none, serial, floating, offline-file or personal.`,
        EXIT.CONFIG_ERROR,
      );
    }
  }
}

/**
 * Returns the licence seat.
 *
 * This is the teardown entrypoint used by the run lifecycle and by signals. It
 * **never throws** — the whole body, including logging and the offline warning,
 * is inside one guard, and the failure path is itself guarded. Every outcome is
 * reported in the result and logged at error level, so the run lifecycle can
 * log a failure loudly without changing its primary exit code (GC9). The call
 * is bounded to 60 s.
 *
 * It runs regardless of mode, too: `return` is a safe no-op when nothing is
 * held, and a run must not guess whether a previous step took a seat.
 */
export async function returnLicense(ctx: CoreContext): Promise<LicenseReturnResult> {
  let seatLeaked = false;

  try {
    // An offline `--file` licence is left in place by `unity license return`,
    // so the seat is held whichever way the CLI call goes. Compute it once and
    // put it on every result (R17).
    seatLeaked = ctx.config.license.mode === 'offline-file';
    if (seatLeaked) {
      safeLog(
        ctx,
        'warn',
        'license.mode is "offline-file": `unity license return` leaves an offline license in place, so this runner leaks a seat that must be reclaimed by hand.',
      );
    }

    const result = await unityLicenseReturn(
      licenseBaseOptions(ctx, {}, LICENSE_RETURN_TIMEOUT_MS),
    );

    if (isUnsupportedCommand(result)) {
      const error =
        'this Unity CLI does not support `license return`; the license seat may still be held.';
      safeLog(ctx, 'error', error);
      return { returned: false, code: result.code, error, seatLeaked };
    }
    if (result.code !== 0) {
      const error =
        `could not return the Unity license: \`unity license return --yes\` failed (exit ${result.code})` +
        `${safeRedact(ctx, failureDetail(result))}. The seat may still be held.`;
      safeLog(ctx, 'error', error);
      return { returned: false, code: result.code, error, seatLeaked };
    }

    safeLog(ctx, 'info', 'Unity license returned (seat released).');
    return { returned: true, code: 0, seatLeaked };
  } catch (error) {
    // Belt and braces: a throw here would mask the run's real result. The
    // caught value may be anything (a string, null), and the logger/redactor
    // may themselves be broken, so nothing below assumes otherwise.
    const message =
      `could not return the Unity license: ${safeRedact(ctx, describeThrown(error))}. ` +
      'The seat may still be held.';
    safeLog(ctx, 'error', message);
    // There is no Unity exit code for "the call never ran": use the same
    // synthetic code the spawn layer uses for a command that could not run.
    return { returned: false, code: EXIT.COMMAND_FAILED, error: message, seatLeaked };
  }
}
