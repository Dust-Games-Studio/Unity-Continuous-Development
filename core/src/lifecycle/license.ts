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
 */
function secretValue(ctx: CoreContext, name: string): string | null {
  const value = ctx.env[name] ?? process.env[name];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
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

/** A one-line description of a failed `unity` call, for a log/error message. */
function failureDetail(result: UnityResult): string {
  const errors = (result.json?.errors ?? [])
    .map((error) => {
      const code = error.code ?? '';
      const message = error.message ?? '';
      if (code !== '' && message !== '') return `${code}: ${message}`;
      return message !== '' ? message : code;
    })
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
  throw new LicenseError(
    `\`unity license activate\` failed for license.mode "${mode}" (exit ${result.code})` +
      ctx.redactor.redact(failureDetail(result)),
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
  const directory = mkdtempSync(join(tmpdir(), 'unityci-license-'));
  const path = join(directory, 'license.ulf');

  try {
    writeFileSync(path, bytes, { mode: 0o600 });
    // The umask can only clear bits, but be explicit: the licence material is
    // readable by its owner and nobody else.
    chmodSync(path, 0o600);

    // An operational fact, not a footnote: `unity license return` leaves an
    // offline licence in place, so this runner's seat must be reclaimed by
    // hand (R17).
    ctx.logger.warn(
      'an offline `--file` license cannot be returned by `unity license return`; this runner leaks a seat that must be reclaimed by hand.',
    );

    const result = await unityLicenseActivate(licenseBaseOptions(ctx), ['--file', path]);
    if (!activationSucceeded(result)) activationFailure(ctx, 'offline-file', result);

    ctx.logger.info('Unity license activated from the offline license file (mode "offline-file").');
    return { activated: true, mode: 'offline-file' };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Activates a Unity licence according to `license.mode`, or reports that none
 * is needed. Secrets travel through the environment only (GC5):
 *
 * - `serial`: `unity license activate` is called with **no** `--serial` flag.
 *   Unity's CLI reads the value from `config.license.serialEnv` itself, by
 *   design, so the serial never appears in any child's `argv`.
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
      ctx.logger.info(
        'license.mode is "none": no activation is performed; an active license is a precondition of the run.',
      );
      return { activated: false, mode };

    case 'serial': {
      const name = ctx.config.license.serialEnv;
      const serial = secretValue(ctx, name);
      // Register before anything is logged, whatever the outcome (GC6).
      ctx.redactor.register(serial);
      if (serial === null) {
        throw new LicenseError(
          `license.mode is "serial" but the environment variable ${name} is empty or unset. ` +
            'Set it in the environment (never in unity-ci.yml or on a command line).',
          EXIT.CONFIG_ERROR,
        );
      }

      ctx.logger.info(
        `activating a Unity license with the serial from ${name} (the CLI reads it from the environment; it is never placed on the command line).`,
      );
      const result = await unityLicenseActivate(
        licenseBaseOptions(ctx, { [name]: serial }),
        [],
      );
      if (!activationSucceeded(result)) activationFailure(ctx, mode, result);

      ctx.logger.info('Unity license activated (mode "serial").');
      return { activated: true, mode };
    }

    case 'floating': {
      ctx.logger.info(
        "activating a Unity license with the floating server configured on this machine (`licensingServiceBaseUrl`).",
      );
      const result = await unityLicenseActivate(licenseBaseOptions(ctx), ['--floating']);
      if (!activationSucceeded(result)) activationFailure(ctx, mode, result);

      ctx.logger.info('Unity license activated (mode "floating").');
      return { activated: true, mode };
    }

    case 'offline-file': {
      const name = ctx.config.license.fileEnv;
      const encoded = secretValue(ctx, name);
      // Register before anything is logged, whatever the outcome (GC6).
      ctx.redactor.register(encoded);
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
      ctx.logger.warn(
        'license.mode is "personal": this route is local-only. Unity\'s licensing backend rejects service-account tokens for activation, so `--personal` cannot work in CI.',
      );
      {
        const result = await unityLicenseActivate(licenseBaseOptions(ctx), [
          '--personal',
          '--accept-eula',
        ]);
        if (!activationSucceeded(result)) activationFailure(ctx, mode, result);
      }

      ctx.logger.info('Unity license activated (mode "personal").');
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
 * Returns the licence seat (GC9).
 *
 * This is the teardown entrypoint used by the run lifecycle and by signals. It
 * **never throws**: every failure is logged at error level and swallowed, so
 * the primary exit code of the run is the only thing the caller sees. The call
 * is bounded to 60 s.
 *
 * It runs regardless of mode, too: `return` is a safe no-op when nothing is
 * held, and a run must not guess whether a previous step took a seat.
 */
export async function returnLicense(ctx: CoreContext): Promise<void> {
  if (ctx.config.license.mode === 'offline-file') {
    ctx.logger.warn(
      'license.mode is "offline-file": `unity license return` leaves an offline license in place, so this runner leaks a seat that must be reclaimed by hand.',
    );
  }

  try {
    const result = await unityLicenseReturn(
      licenseBaseOptions(ctx, {}, LICENSE_RETURN_TIMEOUT_MS),
    );

    if (isUnsupportedCommand(result)) {
      ctx.logger.error(
        'this Unity CLI does not support `license return`; the license seat may still be held. The primary exit code is unchanged (GC9).',
      );
      return;
    }
    if (result.code !== 0) {
      ctx.logger.error(
        `could not return the Unity license: \`unity license return --yes\` failed (exit ${result.code})` +
          `${ctx.redactor.redact(failureDetail(result))}. The seat may still be held; the primary exit code is unchanged (GC9).`,
      );
      return;
    }

    ctx.logger.info('Unity license returned (seat released).');
  } catch (error) {
    // Belt and braces: a thrown error here would mask the run's real result.
    ctx.logger.error(
      `could not return the Unity license: ${(error as Error).message}. The seat may still be held; the primary exit code is unchanged (GC9).`,
    );
  }
}
