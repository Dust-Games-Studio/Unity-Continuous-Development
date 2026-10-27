import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  shouldRetry,
  withRetry,
  type RetryPolicy,
} from '../src/lifecycle/retry.js';

/**
 * The shipped default (GC8). Exit 10 is excluded because it only applies to
 * `unity open --until-ready`; 130/143 are excluded because a signalled CI job
 * must fail, never loop.
 */
const DEFAULT_POLICY: RetryPolicy = {
  onExitCodes: [7, 9, 12, 14],
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
    const fn = vi.fn(async () => outcome('unreachable', 7));
    const waits: number[] = [];

    const run = withRetry(fn, policy, (info) => {
      waits.push(info.waitMs);
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(waits).toEqual([5000, 10_000]);
  });

  it('caps the wait at 60 seconds', async () => {
    // Seven retries: 5s, 10s, 20s, 40s, then 60s for every further wait.
    const policy: RetryPolicy = { ...DEFAULT_POLICY, maxAttempts: 8 };
    const fn = vi.fn(async () => outcome('timeout', 14));
    const waits: number[] = [];

    const run = withRetry(fn, policy, (info) => {
      waits.push(info.waitMs);
    });

    await vi.advanceTimersByTimeAsync(300_000);
    const result = await run;

    expect(fn).toHaveBeenCalledTimes(8);
    expect(result.attempts).toBe(8);
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
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
    const fn = vi.fn(async () => outcome('unreachable', 7));

    const run = withRetry(fn, DEFAULT_POLICY);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLICY.backoffMs);
    const result = await run;

    // A Unity failure is an outcome, not an exception: the caller needs this
    // code for summary.json's unityExitCode.
    expect(result.code).toBe(7);
  });

  it('rethrows a rejection from the attempt without retrying', async () => {
    const fn = vi.fn(async (): Promise<{ value: string; code: number }> => {
      throw new Error('internal bug');
    });

    await expect(withRetry(fn, DEFAULT_POLICY)).rejects.toThrow('internal bug');

    expect(fn).toHaveBeenCalledTimes(1);
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
});
