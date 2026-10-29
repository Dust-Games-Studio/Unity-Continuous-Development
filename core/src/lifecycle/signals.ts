/**
 * Signal handling: a Ctrl-C or a CI timeout on a local run must never leave a
 * Unity seat held.
 *
 * The handler is deliberately small and ordered for one reason: the Editor is
 * killed first, then the seat is returned, then `summary.json` is written, and
 * only then does the process exit. Returning the licence while an Editor still
 * runs would hand back a seat the Editor is still holding, and letting
 * `process.exit` cut off a summary that was never awaited would lose the only
 * record of the run.
 *
 * `SIGKILL` cannot be caught; nothing here applies to it. The adapter's
 * `always()` step covers that case by running `unityci license return`
 * separately.
 */
import { resolve } from 'node:path';
import type { CoreContext } from '../context.js';
import { killAllChildren } from '../exec.js';
import { EXIT } from '../exit-codes.js';
import { buildSummary, deriveStatus, writeSummary } from '../report/summary.js';
import { returnLicense } from './license.js';
import { configuredEditorVersion, redactSummary } from './run-lifecycle.js';

/** The handle returned by {@link installSignalHandlers}. */
export interface SignalHandlers {
  /** Removes the listeners. Idempotent. */
  dispose(): void;
}

export interface SignalHandlerOptions {
  /**
   * Where the final exit goes. Injected by tests: a real `process.exit(130)`
   * inside a vitest worker terminates the worker.
   */
  exit?: (code: number) => void;
  /** How long the teardown may run before the exit happens anyway. */
  timeoutMs?: number;
}

/**
 * The outer backstop: `onSignal` as a whole (licence return **and** summary
 * write) must never hold the exit open forever — a CI timeout may be what sent
 * the signal in the first place.
 */
export const SIGNAL_TEARDOWN_TIMEOUT_MS = 60_000;

/**
 * How long the licence return gets inside the signal teardown.
 *
 * Deliberately shorter than the outer backstop above. The child itself can take
 * ~63 s to settle (Unity's 60 s bound plus the SIGTERM/SIGKILL escalation), so
 * racing the return at 60 s would always lose to the outer race and the summary
 * — the record CI actually reads — would never be written. 45 s leaves ample
 * time to write it.
 */
export const SIGNAL_LICENSE_RETURN_TIMEOUT_MS = 45_000;

/** The command the signal interrupted, for `summary.json`'s `command` key. */
export type SignalCommand = 'test' | 'build';

/**
 * Logs without letting a broken sink break the shutdown. The handler must reach
 * its exit even when stdout is a closed pipe.
 */
function safeLog(
  ctx: CoreContext,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
): void {
  try {
    ctx.logger[level](message);
  } catch {
    // Deliberately swallowed: losing a line is acceptable, losing the exit is
    // not.
  }
}

function describe(error: unknown): string {
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
 * The teardown a signal installs: return the seat (through the same gate as the
 * run lifecycle, so a local run never returns the developer's own licence), then
 * write `summary.json` as an infrastructure failure carrying the signal's exit
 * code.
 *
 * The summary is a **file write**, awaited by the handler, not a log line that
 * `process.exit` may truncate. `status` stays inside the documented set: an
 * interrupt is an infrastructure failure, and `130`/`143` carries the detail.
 *
 * Returned as a function so it can be handed to `installSignalHandlers` as the
 * `onSignal` callback; the command is required because `ctx` does not record
 * which subcommand is running.
 */
export function createSignalTeardown(
  ctx: CoreContext,
  command: SignalCommand,
): (code: number) => Promise<void> {
  return async (code: number): Promise<void> => {
    // Never throws, and it applies the seat gate: `{ skipped: true }` when this
    // process took no seat, or when `license.mode` is `none`. Budgeted shorter
    // than the outer race so a hung return still leaves a summary behind.
    const teardown = await bounded(
      ctx,
      returnLicense(ctx),
      SIGNAL_LICENSE_RETURN_TIMEOUT_MS,
      () => ({
        returned: false,
        code: EXIT.TIMEOUT,
        error: 'the license return did not finish in time; the seat may still be held.',
        // An offline `--file` licence is left in place by `unity license
        // return` whichever way the call goes, so the timeout fallback must
        // not report a leak as clean (R17).
        seatLeaked: ctx.config.license.mode === 'offline-file',
      }),
      `the license return did not finish within ${SIGNAL_LICENSE_RETURN_TIMEOUT_MS} ms; writing summary.json and exiting anyway. The seat may still be held.`,
    );

    const summary = buildSummary({
      command,
      status: deriveStatus(code),
      exitCode: code,
      // `unityExitCode` keeps its 0 default: no Unity invocation necessarily
      // finished, and reporting the signal's own code there would invent a
      // Unity exit code (the same rule as the pre-run config-error summary).
      cliVersion: ctx.cliVersion ?? '',
      cliChannel: ctx.cliChannel,
      cliCommit: ctx.cliCommit,
      editorVersion: configuredEditorVersion(ctx),
      durationMs: Math.max(0, Date.now() - ctx.startedAt),
      license: {
        mode: ctx.config.license.mode,
        activated: ctx.licenseActivated === true,
        returned: teardown.returned === true,
        seatLeaked: teardown.seatLeaked === true,
      },
    });

    const outputDir = resolve(ctx.projectPath, ctx.config.output.dir);
    try {
      // Synchronous write, awaited by the handler: when this returns, the file
      // is on disk and the exit can no longer lose it.
      writeSummary(outputDir, redactSummary(ctx, summary));
      safeLog(
        ctx,
        'info',
        `wrote summary.json (status ${summary.status}, exit ${code}) under ${outputDir} before exiting.`,
      );
    } catch (error) {
      safeLog(
        ctx,
        'error',
        `could not write summary.json under ${outputDir}: ${describe(error)}`,
      );
    }
  };
}

/**
 * Runs `work` with a deadline, resolving with `onTimeout()` (and a warning) if
 * the deadline wins. The timer is deliberately not `unref`'d: with nothing else
 * pending, an unref'd timer would let the event loop drain and the process exit
 * `0` instead of the signal's code.
 */
async function bounded<T>(
  ctx: CoreContext,
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((done) => {
        timer = setTimeout(() => {
          safeLog(ctx, 'warn', message);
          done(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Registers the `SIGINT` and `SIGTERM` handlers.
 *
 * The first signal wins:
 *
 * 1. `handled` is set before anything else, so a second Ctrl-C is ignored.
 *    Running the teardown twice would call `unity license return` on an
 *    already-returned seat and race the first exit.
 * 2. `ctx.signalCode` is recorded before the child kill, so the run lifecycle's
 *    `finally` — which the kill is about to release — knows the signal path now
 *    owns the teardown and the summary.
 * 3. Every live child tree is killed synchronously, before the first `await`.
 * 4. `onSignal(code)` — the licence return and the summary write — is awaited
 *    under {@link SIGNAL_TEARDOWN_TIMEOUT_MS}.
 * 5. The process exits with `130` (SIGINT) or `143` (SIGTERM).
 *
 * `exit` and `timeoutMs` are injectable so tests never call the real
 * `process.exit`; a caller is not required to pass either.
 */
export function installSignalHandlers(
  ctx: CoreContext,
  onSignal: (code: number) => Promise<void>,
  options: SignalHandlerOptions = {},
): SignalHandlers {
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const timeoutMs = options.timeoutMs ?? SIGNAL_TEARDOWN_TIMEOUT_MS;
  let handled = false;

  const handle = (code: number): void => {
    if (handled) return;
    handled = true;

    // Synchronous, and before the kill: killing the child is what makes the
    // in-flight `unity test` resolve and run the run lifecycle's `finally`, and
    // that `finally` must already know the signal owns the teardown and the
    // summary. Otherwise it spawns a second `unity license return` and writes
    // the wrong summary over this one.
    ctx.signalCode = code;

    // Then the Editor must be dead before the licence is handed back.
    try {
      killAllChildren();
    } catch (error) {
      safeLog(
        ctx,
        'error',
        `could not kill the in-flight child processes: ${describe(error)}. An Editor may still hold the seat.`,
      );
    }

    safeLog(
      ctx,
      'warn',
      `received a signal; returning the Unity license before exiting (${code}).`,
    );

    // Not awaited here: the listener returns immediately so Node can run the
    // rest of the loop. The exit at the end is what keeps the process alive.
    void (async (): Promise<void> => {
      try {
        await bounded(
          ctx,
          onSignal(code),
          timeoutMs,
          () => undefined,
          `the license teardown did not finish within ${timeoutMs} ms; exiting anyway. The seat may still be held.`,
        );
      } catch (error) {
        // The teardown never throws by contract, but a broken caller must not
        // prevent the exit either.
        safeLog(
          ctx,
          'error',
          `the license teardown failed after a signal: ${describe(error)}. The seat may still be held.`,
        );
      }
      exit(code);
    })();
  };

  const onInt = (): void => handle(EXIT.INTERRUPTED);
  const onTerm = (): void => handle(EXIT.TERMINATED);

  // Registering a listener replaces Node's default "die now" behaviour, which
  // is exactly what lets the teardown run before the exit.
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  return {
    dispose(): void {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    },
  };
}
