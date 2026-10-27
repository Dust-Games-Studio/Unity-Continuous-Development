import { EXIT } from '../exit-codes.js';

/**
 * The retry policy: whether a failed Unity run is worth running again, and how
 * long to wait before doing so (GC8).
 *
 * The policy is `Config['retry']`. It is exit-code driven on purpose: Unity's
 * own machine-readable table is authoritative, and the core's default differs
 * from it in two deliberate ways — `10` only applies to `unity open
 * --until-ready`, and `130`/`143` are interrupts, where a signalled CI job must
 * fail rather than loop.
 *
 * Four exit codes are never retried, whatever the policy says: `0` is success,
 * `8` means the tests ran and some failed (re-running reproduces the same
 * failures), and `130`/`143` are interrupts — a signalled CI job must fail,
 * never loop. The guards live here, not only in config validation, so they also
 * hold for a hand-built policy.
 *
 * Exit `6` is terminal by default. A pipeline may opt in, but `loadConfig` caps
 * `maxAttempts` at 2 when `6` is in `onExitCodes`, because re-running an
 * identical broken configuration reproduces the failure. That cap lives in the
 * config layer; this module implements the policy it is given.
 */
export interface RetryPolicy {
  onExitCodes: number[];
  maxAttempts: number;
  backoffMs: number;
}

/**
 * The longest wait between attempts. A long pipeline must not stall for hours
 * on an exponential backoff that nobody is watching.
 */
const MAX_BACKOFF_MS = 60_000;

/**
 * Whether `attempt` (1-based) may be followed by another.
 *
 * The four guards are unconditional, not merely a consequence of the default
 * policy: a hand-built or mis-parsed configuration that opts success or an
 * interrupt in must still never loop. Validation rejects these codes too, but
 * validation only protects configurations that came through the loader.
 */
export function shouldRetry(
  policy: RetryPolicy,
  code: number,
  attempt: number,
): boolean {
  return (
    code !== EXIT.SUCCESS &&
    code !== EXIT.TESTS_FAILED &&
    code !== EXIT.INTERRUPTED &&
    code !== EXIT.TERMINATED &&
    policy.onExitCodes.includes(code) &&
    attempt < policy.maxAttempts
  );
}

/**
 * The wait before attempt `attempt + 1`: `min(backoffMs * 2^(attempt - 1),
 * 60_000)`. The first wait is exactly `backoffMs`; each further wait doubles,
 * capped at one minute.
 */
function backoffFor(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Sleeps for `waitMs`, unless `signal` aborts first. An aborted wait clears its
 * timer and rejects with the signal's reason, so a Ctrl-C during a backoff does
 * not hold the job open for the rest of the wait (up to a minute) before the
 * core can return the licence and exit.
 */
function sleep(waitMs: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const activeSignal = signal;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(activeSignal.reason);
    };

    timer = setTimeout(() => {
      activeSignal.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    activeSignal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `fn` and retries it while its exit code is retryable.
 *
 * `fn` resolves with `{ value, code }`: the Unity exit code is part of the
 * attempt's **outcome**, not a rejection. `withRetry` decides from that code
 * whether to try again, so a Unity failure never crosses this boundary as an
 * exception — the caller needs the last code to build `summary.json`
 * (`unityExitCode`) and to derive the run's status.
 *
 * A **rejection** from `fn` is an internal failure (a bug, a thrown error), not
 * a Unity exit code. It is rethrown immediately and never retried: running the
 * same broken code again only reproduces the error more slowly.
 *
 * Attempts are 1-based. `onRetry` is called with the attempt that just
 * finished, its exit code, and the wait that is about to happen, so a caller can
 * log the retry before the delay.
 *
 * `options.signal` makes the wait abortable: a signal that fires during a
 * backoff ends it immediately and rejects with the signal's reason. A signal
 * that is already aborted before the first attempt rejects without calling
 * `fn`, so an interrupted run never spawns another Unity process. A signal that
 * never fires leaves the normal path unchanged.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<{ value: T; code: number }>,
  policy: RetryPolicy,
  onRetry?: (info: { attempt: number; code: number; waitMs: number }) => void,
  options?: { signal?: AbortSignal },
): Promise<{ value: T; attempts: number; code: number }> {
  const signal = options?.signal;
  let attempt = 1;

  for (;;) {
    if (signal?.aborted === true) throw signal.reason;

    const { value, code } = await fn(attempt);

    if (!shouldRetry(policy, code, attempt)) {
      return { value, attempts: attempt, code };
    }

    const waitMs = backoffFor(policy, attempt);
    onRetry?.({ attempt, code, waitMs });
    await sleep(waitMs, signal);
    attempt += 1;
  }
}
