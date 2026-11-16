import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  shouldRetry,
  withRetry,
  type RetryPolicy,
} from '../src/lifecycle/retry.js';

/**
 * The shipped default (GC8). Exit 10 is excluded because it only applies to
 * `unity open --until-ready`; 130/143 are excluded because a signalled CI job
 * must fail, never loop. 16 (`JOB_SUSPENDED`) and 17 (`UNAVAILABLE`, an Editor
 * that is loading, compiling or reloading) are transient and retryable; 15
 * (`RUN_FAILED`) and 18 (`AWAITING_INPUT`, a modal dialog) are not retried by
 * default.
 */
const DEFAULT_POLICY: RetryPolicy = {
  onExitCodes: [7, 9, 12, 14, 16, 17],
  maxAttempts: 2,
  backoffMs: 5000,
};

/** One attempt's outcome: a Unity exit code and the value the caller keeps. */
function outcome(value: string, code: number) {
  return { value, code };
}

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries exit code 7 up to maxAttempts', async () => {
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, DEFAULT_POLICY);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
  });

  it('retries exit code 17 (UNAVAILABLE: an Editor that is loading or compiling)', async () => {
    const fn = vi.fn(async () => outcome('editor busy', 17));

    const run = withRetry(fn, DEFAULT_POLICY);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(17);
  });

  it('retries exit code 16 (JOB_SUSPENDED)', async () => {
    const fn = vi.fn(async () => outcome('job suspended', 16));

    const run = withRetry(fn, DEFAULT_POLICY);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(16);
  });

  it('does not retry exit code 15 (RUN_FAILED) by default', async () => {
    const fn = vi.fn(async () => outcome('run failed', 15));

    const result = await withRetry(fn, DEFAULT_POLICY);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(15);
  });

  it('does not retry exit code 18 (AWAITING_INPUT) by default', async () => {
    // A modal dialog in a batch Editor will not clear on its own; retrying it
    // just burns the job's remaining time. It can still be opted into per
    // pipeline.
    const fn = vi.fn(async () => outcome('dialog', 18));

    const result = await withRetry(fn, DEFAULT_POLICY);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(18);
  });

  it('never retries exit code 8', async () => {
    // The policy opts in, but the unconditional guard wins: exit 8 means the
    // tests ran and some failed, and re-running reproduces the same failures.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, onExitCodes: [8, 7] };
    const fn = vi.fn(async () => outcome('red tests', 8));

    const result = await withRetry(fn, policy);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.code).toBe(8);
    expect(shouldRetry(policy, 8, 1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries exit code 0 even when the policy opts it in', async () => {
    // A successful run must never be repeated: it doubles the work and can turn
    // a flaky-but-green suite red.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, onExitCodes: [0, 7] };
    const fn = vi.fn(async () => outcome('green', 0));

    const result = await withRetry(fn, policy);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.code).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never retries interrupts from a hand-built policy', () => {
    // Validation rejects these codes too, but the in-module guards must hold
    // for a policy that never went through the loader.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, onExitCodes: [0, 130, 143] };

    expect(shouldRetry(policy, 0, 1)).toBe(false);
    expect(shouldRetry(policy, 130, 1)).toBe(false);
    expect(shouldRetry(policy, 143, 1)).toBe(false);
  });

  it('never retries exit code 6 by default', async () => {
    const fn = vi.fn(async () => outcome('no verdict', 6));

    const result = await withRetry(fn, DEFAULT_POLICY);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.attempts).toBe(1);
    expect(result.code).toBe(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries exit code 6 once when it is opted in', async () => {
    // `loadConfig` caps maxAttempts at 2 when 6 is present; the policy here
    // mirrors what a caller receives.
    const policy: RetryPolicy = {
      onExitCodes: [6, 7, 9, 12, 14],
      maxAttempts: 2,
      backoffMs: 5000,
    };
    const fn = vi.fn(async () => outcome('no verdict', 6));

    const run = withRetry(fn, policy);
    await vi.advanceTimersByTimeAsync(policy.backoffMs);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
  });

  it('does not retry when the attempt count is exhausted', async () => {
    const policy: RetryPolicy = { ...DEFAULT_POLICY, maxAttempts: 3 };
    const fn = vi.fn(async () => outcome('locked', 9));

    const run = withRetry(fn, policy);
    await vi.advanceTimersByTimeAsync(5000 + 10_000);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
    expect(shouldRetry(policy, 9, 2)).toBe(true);
    expect(shouldRetry(policy, 9, 3)).toBe(false);
  });

  it('waits backoffMs before the second attempt', async () => {
    const policy: RetryPolicy = { ...DEFAULT_POLICY, maxAttempts: 3 };
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, policy);
    expect(fn).toHaveBeenCalledTimes(1);

    // One millisecond short of the configured backoff: still a single attempt.
    await vi.advanceTimersByTimeAsync(policy.backoffMs - 1);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // Drain the final wait so the run settles.
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
  });

  it('doubles the wait before each further attempt', async () => {
    const policy: RetryPolicy = { ...DEFAULT_POLICY, maxAttempts: 3 };
    const times: number[] = [];
    const waits: number[] = [];
    const fn = vi.fn(async () => {
      times.push(Date.now());
      return outcome('unreachable', 7);
    });

    const run = withRetry(fn, policy, (info) => {
      waits.push(info.waitMs);
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(waits).toEqual([5000, 10_000]);
    // The fake clock proves the delay was actually slept, not merely computed:
    // a `sleep` that ignored its argument would call attempt 2 immediately.
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBe(5000);
    expect(times[2] - times[1]).toBe(10_000);
  });

  it('caps the wait at 60 seconds', async () => {
    // Seven retries: 5s, 10s, 20s, 40s, then 60s for every further wait.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, maxAttempts: 8 };
    const times: number[] = [];
    const waits: number[] = [];
    const fn = vi.fn(async () => {
      times.push(Date.now());
      return outcome('timeout', 14);
    });

    const run = withRetry(fn, policy, (info) => {
      waits.push(info.waitMs);
    });

    await vi.advanceTimersByTimeAsync(300_000);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(8);
    expect(result.attempts).toBe(8);
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    // Five minutes and five seconds of real waiting in total.
    expect(times).toHaveLength(8);
    expect(times[7] - times[0]).toBe(255_000);
  });

  it('caps the first wait at 60 seconds', async () => {
    // With a 90 s backoff, the cap must bind at attempt 1, not only after the
    // exponential sequence has grown past a minute.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, backoffMs: 90_000 };
    const onRetry = vi.fn();
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, policy, onRetry);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await run;

    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, code: 7, waitMs: 60_000 });
  });

  it('returns the last attempt value and the number of attempts', async () => {
    const fn = vi.fn(async (attempt: number) =>
      outcome(attempt === 1 ? 'first attempt' : 'second attempt', 7),
    );

    const run = withRetry(fn, DEFAULT_POLICY);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    expect(result.value).toBe('second attempt');
    expect(result.attempts).toBe(2);
  });

  it('returns the last attempt exit code', async () => {
    // The first attempt fails with 7 (retryable) and the second with 9: the
    // returned code must be the second one, not the first. This is the number
    // `summary.json` records as `unityExitCode`.
    const fn = vi.fn(async (attempt: number) =>
      outcome(attempt === 1 ? 'first attempt' : 'second attempt', attempt === 1 ? 7 : 9),
    );

    const run = withRetry(fn, DEFAULT_POLICY);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    // A Unity failure is an outcome, not an exception: the caller needs this
    // code for summary.json's unityExitCode.
    expect(result.code).toBe(9);
    expect(result.value).toBe('second attempt');
    expect(result.attempts).toBe(2);
  });

  it('rethrows a rejection from the attempt without retrying', async () => {
    const fn = vi.fn(async (): Promise<{ value: string; code: number }> => {
      throw new Error('internal bug');
    });

    await expect(withRetry(fn, DEFAULT_POLICY)).rejects.toThrow('internal bug');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an attempt when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('aborted before the first attempt'), {
      name: 'AbortError',
    });
    controller.abort(reason);
    const fn = vi.fn(async () => outcome('unreachable', 7));

    await expect(
      withRetry(fn, DEFAULT_POLICY, undefined, { signal: controller.signal }),
    ).rejects.toBe(reason);

    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends the backoff wait immediately when the signal aborts', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('aborted during the wait'), {
      name: 'AbortError',
    });
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, DEFAULT_POLICY, undefined, { signal: controller.signal });
    // Let the first attempt resolve and the backoff timer be scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort(reason);

    await expect(run).rejects.toBe(reason);
    expect(fn).toHaveBeenCalledTimes(1);
    // The pending 5 s backoff timer must be cleared, not left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries normally when the signal never fires', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, DEFAULT_POLICY, undefined, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls onRetry with the attempt, the code and the wait', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, DEFAULT_POLICY, onRetry);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    await run;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, code: 7, waitMs: 5000 });
  });

  it('reports the attempt that just finished to onRetry', async () => {
    // With three attempts the callback runs twice: reporting `attempt + 1`
    // would put the wrong number in the log for every retry after the first.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, maxAttempts: 3 };
    const onRetry = vi.fn();
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, policy, onRetry);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(onRetry.mock.calls).toEqual([
      [{ attempt: 1, code: 7, waitMs: 5000 }],
      [{ attempt: 2, code: 7, waitMs: 10_000 }],
    ]);
  });
});
