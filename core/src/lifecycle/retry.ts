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
 * Exit `8` is never retried, whatever the policy says: it means the tests ran
 * and some failed, and re-running the same suite reproduces the same failures.
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
 * The `EXIT.TESTS_FAILED` guard is unconditional, not merely a consequence of
 * the default policy: a hand-built or mis-parsed configuration that opts exit 8
 * in must still never loop on a red test suite.
 */
export function shouldRetry(
  policy: RetryPolicy,
  code: number,
  attempt: number,
): boolean {
  return (
    code !== EXIT.TESTS_FAILED &&
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

/** A plain sleep; the run's signal handling owns interruption. */
function sleep(waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, waitMs);
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
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<{ value: T; code: number }>,
  policy: RetryPolicy,
  onRetry?: (info: { attempt: number; code: number; waitMs: number }) => void,
): Promise<{ value: T; attempts: number; code: number }> {
  let attempt = 1;

  for (;;) {
    const { value, code } = await fn(attempt);

    if (!shouldRetry(policy, code, attempt)) {
      return { value, attempts: attempt, code };
    }

    const waitMs = backoffFor(policy, attempt);
    onRetry?.({ attempt, code, waitMs });
    await sleep(waitMs);
    attempt += 1;
  }
}
