import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { EXIT } from '../src/exit-codes.js';
import {
  SIGNAL_LICENSE_RETURN_TIMEOUT_MS,
  createSignalTeardown,
  installSignalHandlers,
} from '../src/lifecycle/signals.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

/**
 * The signal path spawns nothing itself: the licence teardown goes through
 * `runUnity`, and the child kill lives in `exec.ts`. Both are mocked so the
 * tests can observe the **order** of the two calls without racing a real
 * process exit.
 */
const mocks = vi.hoisted(() => ({
  killAllChildren: vi.fn(),
  runUnity: vi.fn(),
}));

vi.mock('../src/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/exec.js')>();
  return { ...actual, killAllChildren: mocks.killAllChildren };
});

vi.mock('../src/unity/exec.js', () => ({ runUnity: mocks.runUnity }));

interface ResponderCall {
  args: string[];
}

const tempDirs: string[] = [];
const lines: string[] = [];
const order: string[] = [];
/** Every `unity license return` argv the child receives. */
const licenseReturns: string[][] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-signals-'));
  tempDirs.push(dir);
  return dir;
}

function makeContext(root: string, edit?: (config: Config) => void): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  edit?.(config);
  const redactor = createRedactor();
  const logger = createLogger({
    redactor,
    level: 'debug',
    sink: (line) => {
      lines.push(line);
    },
  });
  return {
    config,
    cwd: root,
    projectPath: root,
    env: {},
    logger,
    redactor,
    binary: 'unity',
    startedAt: Date.now(),
    cliVersion: '1.0.0-beta.14',
    cliChannel: 'beta',
    cliCommit: 'abc1234',
    licenseActivated: false,
  };
}

function summaryPath(root: string): string {
  return join(root, 'ci-output', 'summary.json');
}

/** An exit spy that also resolves, so a test never polls for the handler. */
function makeExit(): {
  exit: (code: number) => void;
  exited: Promise<number>;
  codes: number[];
} {
  const codes: number[] = [];
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((done) => {
    resolve = done;
  });
  const exit = (code: number): void => {
    codes.push(code);
    resolve(code);
  };
  return { exit, exited, codes };
}

beforeEach(() => {
  lines.length = 0;
  order.length = 0;
  licenseReturns.length = 0;
  mocks.runUnity.mockReset();
  mocks.killAllChildren.mockReset();
  mocks.killAllChildren.mockImplementation(() => {
    order.push('kill-children');
  });
  mocks.runUnity.mockImplementation(
    async (options: ResponderCall): Promise<{
      code: number;
      stdout: string;
      stderr: string;
      json: unknown;
    }> => {
      if (options.args[0] === 'license') {
        order.push('license-return');
        licenseReturns.push(options.args);
      }
      return { code: 0, stdout: '', stderr: '', json: { success: true, data: {} } };
    },
  );
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('installSignalHandlers', () => {
  it('returns the license on SIGINT', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    ctx.licenseActivated = true;
    const { exit, exited } = makeExit();
    const handlers = installSignalHandlers(ctx, createSignalTeardown(ctx, 'test'), {
      exit,
    });

    try {
      process.emit('SIGINT');
      await expect(exited).resolves.toBe(EXIT.INTERRUPTED);
    } finally {
      handlers.dispose();
    }

    expect(licenseReturns).toEqual([['license', 'return', '--yes', '--format', 'json']]);
  });

  it('returns the license on SIGTERM', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    ctx.licenseActivated = true;
    const { exit, exited } = makeExit();
    const handlers = installSignalHandlers(ctx, createSignalTeardown(ctx, 'test'), {
      exit,
    });

    try {
      process.emit('SIGTERM');
      await expect(exited).resolves.toBe(EXIT.TERMINATED);
    } finally {
      handlers.dispose();
    }

    expect(licenseReturns).toHaveLength(1);
  });

  it('exits 130 on SIGINT and 143 on SIGTERM', async () => {
    const root = makeProject();
    const onSignal = vi.fn(async (_code: number) => {});

    for (const [signal, expected] of [
      ['SIGINT', EXIT.INTERRUPTED],
      ['SIGTERM', EXIT.TERMINATED],
    ] as const) {
      const ctx = makeContext(root);
      const { exit, exited } = makeExit();
      const handlers = installSignalHandlers(ctx, onSignal, { exit });
      try {
        process.emit(signal);
        await expect(exited).resolves.toBe(expected);
      } finally {
        handlers.dispose();
      }
    }

    expect(onSignal.mock.calls.map(([code]) => code)).toEqual([
      EXIT.INTERRUPTED,
      EXIT.TERMINATED,
    ]);
  });

  it('kills the in-flight unity child before returning the license', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    ctx.licenseActivated = true;
    const { exit, exited } = makeExit();
    // The lifecycle's `finally` reads `ctx.signalCode` the moment the killed
    // child resolves, so it must already be set when the kill happens.
    let codeAtKill: number | undefined;
    mocks.killAllChildren.mockImplementation(() => {
      order.push('kill-children');
      codeAtKill = ctx.signalCode;
    });
    const handlers = installSignalHandlers(ctx, createSignalTeardown(ctx, 'test'), {
      exit,
    });

    try {
      process.emit('SIGINT');
      await exited;
    } finally {
      handlers.dispose();
    }

    // Returning the seat while an Editor still runs would hand back a licence
    // the Editor is still holding.
    expect(order).toEqual(['kill-children', 'license-return']);
    expect(codeAtKill).toBe(EXIT.INTERRUPTED);
    expect(ctx.signalCode).toBe(EXIT.INTERRUPTED);
  });

  it('writes summary.json before exiting on a signal', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
      config.test.outputDir = 'ci-output/tests';
    });
    ctx.licenseActivated = true;

    // The file must already be on disk **at exit time**: a summary written after
    // the exit would be lost to `process.exit` in a real run.
    let atExit: Record<string, unknown> | null = null;
    let resolve!: (code: number) => void;
    const exited = new Promise<number>((done) => {
      resolve = done;
    });
    const exit = (code: number): void => {
      atExit = existsSync(summaryPath(root))
        ? (JSON.parse(readFileSync(summaryPath(root), 'utf8')) as Record<string, unknown>)
        : null;
      resolve(code);
    };

    const handlers = installSignalHandlers(ctx, createSignalTeardown(ctx, 'test'), {
      exit,
    });
    try {
      process.emit('SIGINT');
      await expect(exited).resolves.toBe(EXIT.INTERRUPTED);
    } finally {
      handlers.dispose();
    }

    expect(atExit).not.toBeNull();
    expect(atExit).toMatchObject({
      schema: 1,
      command: 'test',
      // Not a new status: an interrupt is an infrastructure failure, and the
      // exit code carries the detail.
      status: 'infra_failed',
      exitCode: EXIT.INTERRUPTED,
      cliVersion: '1.0.0-beta.14',
      license: { mode: 'serial', activated: true, returned: true, seatLeaked: false },
    });
    // The signals path must not invent a schema of its own (GC11).
    expect(Object.keys(atExit ?? {}).sort()).toEqual(
      [
        'schema',
        'command',
        'status',
        'exitCode',
        'unityExitCode',
        'attempts',
        'cliVersion',
        'cliChannel',
        'cliCommit',
        'editorVersion',
        'durationMs',
        'tests',
        'reports',
        'license',
        'artifacts',
        'logs',
      ].sort(),
    );
  });

  it('does not return a license this process did not activate', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    const { exit, exited } = makeExit();
    const handlers = installSignalHandlers(ctx, createSignalTeardown(ctx, 'test'), {
      exit,
    });

    try {
      process.emit('SIGTERM');
      await exited;
    } finally {
      handlers.dispose();
    }

    // The seat gate in `returnLicense` still applies on the signal path: a local
    // run must never return the developer's own licence.
    expect(licenseReturns).toHaveLength(0);
    const summary = JSON.parse(readFileSync(summaryPath(root), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      status: 'infra_failed',
      exitCode: EXIT.TERMINATED,
      license: { activated: false, returned: false },
    });
  });

  it('does not return the license twice when two signals arrive', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    ctx.licenseActivated = true;

    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const onSignal = vi.fn(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const { exit, exited, codes } = makeExit();
    const handlers = installSignalHandlers(ctx, onSignal, { exit });
    try {
      process.emit('SIGINT');
      await began;
      // A second Ctrl-C while the teardown is still running.
      process.emit('SIGINT');
      process.emit('SIGTERM');
      release();
      await exited;
    } finally {
      handlers.dispose();
    }

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(codes).toEqual([EXIT.INTERRUPTED]);
  });

  it('bounds the teardown with a timeout so a hung return cannot block the exit', async () => {
    const root = makeProject();
    const ctx = makeContext(root);
    const onSignal = vi.fn(() => new Promise<void>(() => {}));

    vi.useFakeTimers();
    const { exit, codes } = makeExit();
    const handlers = installSignalHandlers(ctx, onSignal, { exit, timeoutMs: 5000 });
    try {
      process.emit('SIGTERM');
      expect(onSignal).toHaveBeenCalledTimes(1);
      expect(codes).toEqual([]);

      await vi.advanceTimersByTimeAsync(5000);

      expect(codes).toEqual([EXIT.TERMINATED]);
    } finally {
      handlers.dispose();
    }
  });

  it('writes summary.json even when the license return itself hangs', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    ctx.licenseActivated = true;
    // The child never settles. The inner 45 s budget — not the outer 60 s
    // backstop — must win, or the summary would never be written.
    mocks.runUnity.mockImplementation(() => new Promise<never>(() => {}));

    vi.useFakeTimers();
    const { exit, codes } = makeExit();
    const handlers = installSignalHandlers(ctx, createSignalTeardown(ctx, 'test'), {
      exit,
    });
    try {
      process.emit('SIGINT');
      expect(codes).toEqual([]);

      await vi.advanceTimersByTimeAsync(SIGNAL_LICENSE_RETURN_TIMEOUT_MS);

      expect(codes).toEqual([EXIT.INTERRUPTED]);
      const summary = JSON.parse(readFileSync(summaryPath(root), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(summary).toMatchObject({
        status: 'infra_failed',
        exitCode: EXIT.INTERRUPTED,
        license: { mode: 'serial', activated: true, returned: false },
      });
      expect(lines.join('')).toContain('did not finish within');
    } finally {
      handlers.dispose();
    }
  });

  it('exits anyway when onSignal rejects', async () => {
    const root = makeProject();
    const ctx = makeContext(root);
    const onSignal = vi.fn(async () => {
      throw new Error('the teardown exploded');
    });
    const { exit, exited, codes } = makeExit();
    const handlers = installSignalHandlers(ctx, onSignal, { exit });

    try {
      process.emit('SIGTERM');
      await expect(exited).resolves.toBe(EXIT.TERMINATED);
    } finally {
      handlers.dispose();
    }

    // Delete the catch around `onSignal` and this hangs: the exit is the whole
    // point of the handler.
    expect(codes).toEqual([EXIT.TERMINATED]);
    expect(lines.join('')).toContain('the teardown exploded');
  });

  it('removes its listeners on dispose', async () => {
    const root = makeProject();
    const ctx = makeContext(root);
    const onSignal = vi.fn(async () => {});
    const { exit, codes } = makeExit();
    const before = process.listenerCount('SIGINT');
    const handlers = installSignalHandlers(ctx, onSignal, { exit });

    handlers.dispose();
    handlers.dispose();

    expect(process.listenerCount('SIGINT')).toBe(before);
    // A second run must not inherit the first one's handlers.
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSignal).not.toHaveBeenCalled();
    expect(codes).toEqual([]);
  });
});
