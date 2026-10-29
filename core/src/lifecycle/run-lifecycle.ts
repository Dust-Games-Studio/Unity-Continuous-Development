/**
 * The one run lifecycle both commands use: `doctor` → `setup` → activate →
 * execute → verify → `summary.json`, with the licence teardown and the summary
 * on every path the run itself owns.
 *
 * `runTest` and `runBuild` differ only in what they execute and verify and in
 * the summary fields they contribute. The sequence, the retry loop, the
 * teardown and the summary wiring live here so Task 11's signal path
 * instruments **one** lifecycle rather than two that can drift apart.
 *
 * The preflight comes first, as the spec's Section 4.5 orders it; `setup` then
 * verifies or installs the Editor and accepts its terms. The teardown is
 * entered on every path this function owns, including a doctor or setup
 * failure, where it is a no-op because nothing was activated. A signalled run
 * is owned by the signal path instead (Task 11): it returns the seat and writes
 * the summary, and this function's `finally` stops rather than racing it.
 */
import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { doctorCommand } from '../commands/doctor.js';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import {
  buildSummary,
  deriveStatus,
  writeSummary,
  type Summary,
} from '../report/summary.js';
import {
  LicenseError,
  activateLicense,
  returnLicense,
  type LicenseActivation,
  type LicenseReturnResult,
} from './license.js';
import { withRetry } from './retry.js';
import {
  SetupError,
  setup,
  type SetupOptions,
  type SetupResult,
} from './setup.js';

/** The verdict plus what the command did, as far as the summary needs it. */
export interface LifecycleExecution<T> {
  /** Command-private payload handed to {@link LifecycleDefinition.verify}. */
  data: T;
  unityExitCode: number;
  attempts: number;
}

/** What a command's verification decided. */
export interface LifecycleVerification {
  exitCode: number;
}

/** The summary fields and extra top-level keys a command contributes. */
export interface LifecycleSummary {
  fields?: Partial<Summary>;
  /** Already-redacted extra keys (the build's provenance manifest). */
  extras?: Record<string, unknown>;
}

export interface LifecycleDefinition<T> {
  /** The `summary.json` command name. */
  command: 'test' | 'build';
  /** Passed to `setup`; the command owns its module requirement. */
  setupOptions: SetupOptions;
  /** The noun in the doctor-failure line: `tests` or `build`. */
  doctorSubject: string;
  /** Runs the command's Unity invocations after setup and activation. */
  execute: (ctx: CoreContext) => Promise<LifecycleExecution<T>>;
  /**
   * Turns the executions into a verdict. It owns the command's artifact and
   * report verification, because for a test run the verdict is per invocation.
   */
  verify: (
    ctx: CoreContext,
    execution: LifecycleExecution<T>,
  ) => Promise<LifecycleVerification>;
  /** Called from the `finally`, after execute/verify and before writing. */
  summary: (ctx: CoreContext) => LifecycleSummary;
}

export interface LifecycleResult {
  exitCode: number;
  unityExitCode: number;
  attempts: number;
  setupResult: SetupResult | null;
}

/** True for an existing, non-empty regular file (R18). */
export function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/** A path relative to the output directory, with forward slashes. */
export function reportPath(outputDir: string, file: string): string {
  const relativePath = relative(outputDir, file);
  const value =
    relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)
      ? file
      : relativePath;
  return value.split(sep).join('/');
}

/** The configured Editor version, for a summary written before `setup` ran. */
export function configuredEditorVersion(ctx: CoreContext): string {
  const configured = ctx.config.unity.editor.version;
  // `from-project` is unknown until setup reads ProjectVersion.txt; an empty
  // value is honest, a guessed one is not.
  return configured === 'from-project' ? '' : configured;
}

/** The summary with every free-form string masked before it is serialised (GC5). */
export function redactSummary(ctx: CoreContext, summary: Summary): Summary {
  const redact = (value: string): string => ctx.redactor.redact(value);
  const optional = (value: string | null): string | null =>
    value === null ? null : redact(value);
  return {
    ...summary,
    cliVersion: redact(summary.cliVersion),
    cliChannel: optional(summary.cliChannel),
    cliCommit: optional(summary.cliCommit),
    editorVersion: redact(summary.editorVersion),
    tests: { ...summary.tests },
    reports: {
      nunit: summary.reports.nunit.map(redact),
      junit: summary.reports.junit.map(redact),
    },
    license: { ...summary.license, mode: redact(summary.license.mode) },
    artifacts: summary.artifacts.map(redact),
    logs: {
      editor: optional(summary.logs.editor),
      cli: optional(summary.logs.cli),
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GC9's teardown, called from the `finally` on every path this function owns.
 * The seat gate lives in `returnLicense` and reads `ctx.licenseActivated`, so a
 * signal-driven teardown (Task 11), which cannot see this function's locals,
 * inherits exactly the same rule. When a signal has set `ctx.signalCode` the
 * signal path owns the teardown and `runLifecycle` does not call this function
 * at all. Nothing activated (a failed doctor or setup, `license.mode: none`)
 * means nothing is returned — a developer's own personal licence must never be
 * returned as a side effect of running the toolkit locally.
 */
export async function teardownLicense(ctx: CoreContext): Promise<LicenseReturnResult> {
  try {
    return await returnLicense(ctx);
  } catch (error) {
    // `returnLicense` does not throw today; a regression here must still not
    // mask the primary exit code or stop `summary.json` from being written.
    ctx.logger.error(
      `the license teardown failed: ${describe(error)}. The seat may still be held.`,
    );
    return { returned: false, code: EXIT.COMMAND_FAILED };
  }
}

/**
 * The one retry loop both commands use. `prepare` runs before every attempt (a
 * caller removes its own stale reports there); `withRetry` owns the policy and
 * the backoff, and the warning names the invocation so a build and a test run
 * are distinguishable in the log.
 */
export async function runWithRetry<T>(
  ctx: CoreContext,
  label: string,
  attempt: () => Promise<{ value: T; code: number }>,
  prepare?: () => void,
): Promise<{ value: T; attempts: number; code: number }> {
  return withRetry<T>(
    async () => {
      prepare?.();
      return attempt();
    },
    ctx.config.retry,
    (info) => {
      ctx.logger.warn(
        `${label} exited ${info.code} on attempt ${info.attempt}; retrying in ${info.waitMs}ms.`,
      );
    },
  );
}

/**
 * Runs one command through the shared lifecycle.
 *
 * It never throws for an expected failure: every path writes `summary.json`
 * and returns a verdict, so a stale green summary cannot survive a failed run.
 * An unexpected exception is a bug and becomes exit 65 after the teardown and
 * the summary still run.
 */
export async function runLifecycle<T>(
  ctx: CoreContext,
  definition: LifecycleDefinition<T>,
): Promise<LifecycleResult> {
  const summaryDir = resolve(ctx.projectPath, ctx.config.output.dir);

  let setupResult: SetupResult | null = null;
  let activation: LicenseActivation | null = null;
  let teardown: LicenseReturnResult | null = null;
  let execution: LifecycleExecution<T> | null = null;

  let exitCode: number = EXIT.SUCCESS;
  let unityExitCode: number = EXIT.SUCCESS;
  let attempts = 1;

  try {
    // The preflight gate (R11) comes first, as the spec's Section 4.5 orders it
    // (`doctor → setup → … → license step`). `setup` deliberately does not run
    // `unity doctor --ci`; without this call the run path would never execute
    // the preflight at all.
    const doctorCode = await doctorCommand(ctx);
    if (doctorCode !== EXIT.SUCCESS) {
      ctx.logger.error(
        `the doctor preflight failed with exit ${doctorCode}; refusing to run the ${definition.doctorSubject}.`,
      );
      exitCode = doctorCode;
    } else {
      setupResult = await setup(ctx, definition.setupOptions);
      activation = await activateLicense(ctx);
      // The gate every later teardown reads — including a signal-driven one
      // that cannot see this function's locals (Task 11).
      if (activation.activated) ctx.licenseActivated = true;

      execution = await definition.execute(ctx);
      unityExitCode = execution.unityExitCode;
      attempts = execution.attempts;
      exitCode = (await definition.verify(ctx, execution)).exitCode;
    }
  } catch (error) {
    if (error instanceof SetupError || error instanceof LicenseError) {
      ctx.logger.error(error.message);
      exitCode = error.exitCode;
    } else {
      ctx.logger.error(
        `the ${definition.command} run failed unexpectedly: ${describe(error)}`,
      );
      exitCode = EXIT.INTERNAL_ERROR;
    }
  } finally {
    // Ownership, not agreement. When a signal arrives, the signal path kills
    // the Editor, returns the seat and writes `summary.json`; this function
    // stops instead of racing it. A second `unity license return` in that
    // moment fails against the seat the handler is returning and can land
    // first, and a summary written here would replace the signal's
    // `infra_failed`/130 record with the killed child's exit code.
    if (ctx.signalCode !== undefined) {
      ctx.logger.warn(
        'a signal owns this run: not returning the license or writing summary.json here; the signal handler does both.',
      );
    } else {
      // GC9: the teardown is entered on every path, and its seat gate — not this
      // function's locals — decides whether anything is returned.
      teardown = await teardownLicense(ctx);

      // A signal can land while that teardown runs. Check again before writing:
      // from here on the signal path is the only writer, even when the
      // teardown above had already claimed the seat.
      if (ctx.signalCode !== undefined) {
        ctx.logger.warn(
          'a signal arrived during the license teardown: leaving summary.json to the signal handler.',
        );
      } else {
        const contribution = definition.summary(ctx);
        const summary = buildSummary({
          command: definition.command,
          status: deriveStatus(exitCode),
          exitCode,
          // Decision 5: the real Unity exit code of the last attempt, never a
          // second, more flattering number.
          unityExitCode,
          attempts,
          cliVersion: ctx.cliVersion ?? '',
          cliChannel: ctx.cliChannel,
          cliCommit: ctx.cliCommit,
          editorVersion: setupResult?.editorVersion ?? configuredEditorVersion(ctx),
          durationMs: Math.max(0, Date.now() - ctx.startedAt),
          license: {
            mode: activation?.mode ?? ctx.config.license.mode,
            activated: activation?.activated === true,
            returned: teardown?.returned === true,
            seatLeaked: teardown?.seatLeaked === true,
          },
          ...contribution.fields,
        });

        // `writeSummary` takes the documented `Summary`; the intersection keeps a
        // command's extra top-level key (build provenance) honest.
        const published: Summary & Record<string, unknown> = {
          ...redactSummary(ctx, summary),
          ...(contribution.extras ?? {}),
        };

        try {
          writeSummary(summaryDir, published);
          ctx.logger.info(
            `${definition.command} status ${summary.status} (exit ${exitCode}); summary at ${join(summaryDir, 'summary.json')}.`,
          );
        } catch (error) {
          ctx.logger.error(
            `could not write summary.json under ${summaryDir}: ${describe(error)}`,
          );
          exitCode = EXIT.INTERNAL_ERROR;
        }
      }
    }
  }

  return { exitCode, unityExitCode, attempts, setupResult };
}
