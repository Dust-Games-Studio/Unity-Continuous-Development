import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/commands/run.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { LicenseError } from '../src/lifecycle/license.js';
import { SetupError } from '../src/lifecycle/setup.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  unityBaseOptions: vi.fn(),
  activateLicense: vi.fn(),
  doctorCommand: vi.fn(),
  runUnity: vi.fn(),
}));

vi.mock('../src/lifecycle/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lifecycle/setup.js')>();
  return { ...actual, setup: mocks.setup, unityBaseOptions: mocks.unityBaseOptions };
});

// Only activation is mocked: the real `returnLicense` runs, so its seat gate is
// exercised by the run path itself and not only by license.test.ts.
vi.mock('../src/lifecycle/license.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lifecycle/license.js')>();
  return { ...actual, activateLicense: mocks.activateLicense };
});

vi.mock('../src/commands/doctor.js', () => ({
  doctorCommand: mocks.doctorCommand,
}));

vi.mock('../src/unity/exec.js', () => ({
  runUnity: mocks.runUnity,
}));

const PASS = readFileSync(new URL('./fixtures/editmode-pass.xml', import.meta.url), 'utf8');
const FAIL = readFileSync(new URL('./fixtures/editmode-fail.xml', import.meta.url), 'utf8');
const ZERO_TESTS = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="0" result="Passed" total="0" passed="0" failed="0" inconclusive="0" skipped="0" />`;

interface TestOutcome {
  code: number;
  /** The NUnit report the fake Editor writes, or null/undefined for none. */
  report?: string | null;
}

interface ResponderCall {
  args: string[];
  mode: string;
  output: string;
  junit: string;
}

const tempDirs: string[] = [];
const lines: string[] = [];
const order: string[] = [];
/** The final `unity test` argv the child receives. */
const testCalls: string[][] = [];
/** Every `unity license return` argv the child receives. */
const licenseReturns: string[][] = [];
let responder: (call: ResponderCall) => TestOutcome;

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-run-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeContext(root: string, edit?: (config: Config) => void): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  // The retry tests must not wait out the production backoff.
  config.retry.backoffMs = 0;
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
    cliVersion: null,
    cliChannel: null,
    cliCommit: null,
    licenseActivated: false,
  };
}

function summaryPath(root: string): string {
  return join(root, 'ci-output', 'summary.json');
}

function readSummary(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(summaryPath(root), 'utf8')) as Record<string, unknown>;
}

function textOutput(): string {
  return lines.join('');
}

beforeEach(() => {
  lines.length = 0;
  order.length = 0;
  testCalls.length = 0;
  licenseReturns.length = 0;
  responder = () => ({ code: 0, report: PASS });
  for (const mock of Object.values(mocks)) mock.mockReset();

  mocks.setup.mockImplementation(async (ctx: CoreContext) => {
    order.push('setup');
    ctx.cliVersion = '1.0.0-beta.14';
    ctx.cliChannel = 'beta';
    ctx.cliCommit = 'abc1234';
    return {
      editorVersion: '6000.6.3f1',
      cliVersion: '1.0.0-beta.14',
      cliChannel: 'beta',
      cliCommit: 'abc1234',
      installed: false,
      doctorVerdict: 'unknown' as const,
    };
  });

  mocks.unityBaseOptions.mockImplementation((ctx: CoreContext) => ({
    binary: ctx.binary,
    cwd: ctx.projectPath,
    env: ctx.env,
    logger: ctx.logger,
    redactor: ctx.redactor,
  }));

  mocks.doctorCommand.mockImplementation(async () => {
    order.push('doctor');
    return 0;
  });

  mocks.activateLicense.mockImplementation(async (ctx: CoreContext) => {
    order.push('activate');
    return { activated: ctx.config.license.mode !== 'none', mode: ctx.config.license.mode };
  });

  mocks.runUnity.mockImplementation(
    async (options: { args: string[] }): Promise<{
      code: number;
      stdout: string;
      stderr: string;
      json: unknown;
    }> => {
      const args = options.args;
      if (args[0] === 'license') {
        order.push('license-return');
        licenseReturns.push(args);
        return { code: 0, stdout: '', stderr: '', json: { success: true, data: {} } };
      }

      order.push('unity-test');
      testCalls.push(args);
      const mode = valueAfter(args, '--mode');
      const output = valueAfter(args, '--output');
      const junit = valueAfter(args, '--junit-output');
      const outcome = responder({ args, mode, output, junit });
      if (outcome.report !== null && outcome.report !== undefined) {
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, outcome.report);
        // `--report-format nunit,junit --junit-output` makes Unity write both.
        writeFileSync(junit, '<testsuites />');
      }
      return {
        code: outcome.code,
        stdout: '',
        stderr: '',
        json: { success: outcome.code === 0, data: {} },
      };
    },
  );
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('run test', () => {
  it('runs the doctor, setup, activates the license, runs the tests and returns the license', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(0);
    // The binding order (Section 4.5): doctor → setup → license → run → teardown.
    expect(order).toEqual(['doctor', 'setup', 'activate', 'unity-test', 'license-return']);
    expect(ctx.licenseActivated).toBe(true);
    expect(readSummary(root).license).toMatchObject({
      mode: 'serial',
      activated: true,
      returned: true,
    });
  });

  it('returns the license when the test run fails', async () => {
    responder = () => ({ code: 8, report: FAIL });
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(8);
    expect(licenseReturns).toHaveLength(1);
    expect(licenseReturns[0]).toEqual(['license', 'return', '--yes', '--format', 'json']);
    expect(readSummary(root).license).toMatchObject({ activated: true, returned: true });
  });

  it('stops without touching the license or summary.json when a signal owns the run', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });
    // The handler records the signal before killing the child; the killed
    // `unity test` then resolves and the run continues into its `finally`.
    responder = () => {
      ctx.signalCode = 130;
      return { code: 0, report: PASS };
    };

    await runCommand(ctx, 'test');

    // One owner: the signal path returns the seat and writes summary.json. A
    // second `unity license return` here would race the handler's, and a summary
    // written here would replace its infra_failed/130 with the killed child's
    // exit code.
    expect(licenseReturns).toHaveLength(0);
    expect(existsSync(summaryPath(root))).toBe(false);
    expect(textOutput()).toContain('a signal owns this run');
  });

  it('returns the license when setup fails', async () => {
    mocks.setup.mockImplementation(async () => {
      order.push('setup');
      throw new SetupError('the Unity Editor 6000.6.3f1 is not installed.', 64);
    });
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(64);
    // The teardown step is entered on every path, but it releases nothing: no
    // seat was activated, so `unity license return` must never run (a developer's
    // own personal licence would otherwise be returned as a side effect).
    expect(order).toEqual(['doctor', 'setup']);
    expect(mocks.activateLicense).not.toHaveBeenCalled();
    expect(licenseReturns).toHaveLength(0);
    expect(textOutput()).toContain('activated no license seat');
    expect(readSummary(root).status).toBe('config_error');
  });

  it('does not run unity license return when it activated nothing', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(0);
    expect(mocks.activateLicense).toHaveBeenCalledTimes(1);
    expect(ctx.licenseActivated).toBe(false);
    expect(licenseReturns).toHaveLength(0);
    expect(textOutput()).toContain('activated no license seat');
    expect(readSummary(root).license).toMatchObject({
      mode: 'none',
      activated: false,
      returned: false,
    });
  });

  it('runs one unity test per configured mode and collects both reports', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.test.modes = ['EditMode', 'PlayMode'];
    });

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(0);
    expect(testCalls).toHaveLength(2);
    expect(testCalls.map((args) => valueAfter(args, '--mode'))).toEqual(['EditMode', 'PlayMode']);
    const summary = readSummary(root);
    expect(summary.reports).toEqual({
      nunit: ['tests/EditMode.xml', 'tests/PlayMode.xml'],
      junit: ['tests/EditMode.junit.xml', 'tests/PlayMode.junit.xml'],
    });
    expect(summary.tests).toEqual({ total: 6, passed: 4, failed: 0, skipped: 2 });
  });

  it('never emits two --mode flags in one invocation', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.test.modes = ['EditMode', 'PlayMode'];
    });

    await runCommand(ctx, 'test');

    expect(testCalls).toHaveLength(2);
    for (const args of testCalls) {
      expect(args.filter((arg) => arg === '--mode')).toHaveLength(1);
      expect(args).not.toContain('--allow-install');
    }
  });

  it('rejects a report path that is an existing directory', async () => {
    const root = makeProject();
    mkdirSync(join(root, 'ci-output', 'tests', 'EditMode.xml'), { recursive: true });
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(64);
    expect(mocks.doctorCommand).not.toHaveBeenCalled();
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(testCalls).toHaveLength(0);
    const summary = readSummary(root);
    expect(summary.status).toBe('config_error');
    expect(summary.exitCode).toBe(64);
  });

  it('never passes --allow-install', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    await runCommand(ctx, 'test');

    expect(testCalls).toHaveLength(1);
    expect(testCalls[0]).not.toContain('--allow-install');
  });

  it('requests nunit and junit natively from unity', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    await runCommand(ctx, 'test');

    const args = testCalls[0]!;
    expect(valueAfter(args, '--report-format')).toBe('nunit,junit');
    expect(valueAfter(args, '--junit-output')).toBe(
      join(root, 'ci-output', 'tests', 'EditMode.junit.xml'),
    );
    expect(valueAfter(args, '--output')).toBe(join(root, 'ci-output', 'tests', 'EditMode.xml'));
    // The final argv, not the caller's args: `unityTest` owns `--format json`.
    expect(valueAfter(args, '--format')).toBe('json');
  });

  it('passes the configured filter, coverage, shard and per-test retries', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.test.filter = 'Game.Tests.MathTests';
      config.test.coverage = true;
      config.test.shards = '1/3';
      config.test.retries = 2;
    });

    await runCommand(ctx, 'test');

    const args = testCalls[0]!;
    expect(valueAfter(args, '--filter')).toBe('Game.Tests.MathTests');
    expect(args).toContain('--coverage');
    expect(valueAfter(args, '--coverage-output')).toBe(
      join(root, 'ci-output', 'tests', 'coverage'),
    );
    // `--shard` takes N/M verbatim; the core never parses or derives it.
    expect(valueAfter(args, '--shard')).toBe('1/3');
    expect(valueAfter(args, '--retries')).toBe('2');
  });

  it('retries exit code 7, reports attempts 2 and counts one report', async () => {
    // Both attempts write a report. A run loop that summed across attempts would
    // report 6 tests here; the last attempt's report says 3.
    let attempt = 0;
    responder = () => {
      attempt += 1;
      return { code: attempt === 1 ? 7 : 0, report: PASS };
    };
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(0);
    expect(testCalls).toHaveLength(2);
    const summary = readSummary(root);
    expect(summary.attempts).toBe(2);
    expect(summary.status).toBe('passed');
    expect(summary.unityExitCode).toBe(0);
    expect(summary.tests).toEqual({ total: 3, passed: 2, failed: 0, skipped: 1 });
  });

  it('does not retry exit code 8', async () => {
    responder = () => ({ code: 8, report: FAIL });
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(8);
    expect(testCalls).toHaveLength(1);
    expect(readSummary(root).attempts).toBe(1);
  });

  it('exits 8 when tests ran and some failed', async () => {
    responder = () => ({ code: 8, report: FAIL });
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(8);
    const summary = readSummary(root);
    expect(summary.status).toBe('tests_failed');
    expect(summary.exitCode).toBe(8);
    expect(summary.unityExitCode).toBe(8);
    expect(summary.tests).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it('exits 6 when the run produced no report at all', async () => {
    responder = () => ({ code: 0, report: null });
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(6);
    const summary = readSummary(root);
    expect(summary.status).toBe('infra_failed');
    expect(summary.exitCode).toBe(6);
    // The last attempt really exited 0: the false green is refused by the
    // artifact check, not by pretending Unity failed.
    expect(summary.unityExitCode).toBe(0);
  });

  it('exits 6 when the NUnit report exists but is zero bytes', async () => {
    responder = () => ({ code: 0, report: '' });
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(6);
    expect(existsSync(join(root, 'ci-output', 'tests', 'EditMode.xml'))).toBe(true);
    // An empty artifact is not a produced artifact: the run is verified as
    // missing, not parsed as a zero-count pass (R18).
    expect(textOutput()).toContain('produced no NUnit report');
    const summary = readSummary(root);
    expect(summary.status).toBe('infra_failed');
    expect(summary.exitCode).toBe(6);
    expect(summary.unityExitCode).toBe(0);
    expect(summary.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it('exits 6 when a mode exited 8 but wrote no report', async () => {
    responder = () => ({ code: 8, report: null });
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(6);
    expect(readSummary(root).status).toBe('infra_failed');
  });

  it('exits 65 when the NUnit report exists but cannot be parsed', async () => {
    responder = () => ({ code: 0, report: '<test-run total="1"' });
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(65);
    const summary = readSummary(root);
    expect(summary.status).toBe('infra_failed');
    expect(summary.exitCode).toBe(65);
    expect(summary.unityExitCode).toBe(0);
    expect(summary.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it('removes a stale report before a retry so the last attempt owns the artifact', async () => {
    let attempt = 0;
    responder = () => {
      attempt += 1;
      // The first attempt writes a green report and then fails the invocation;
      // the retry crashes without writing one. The stale file must not count.
      return attempt === 1 ? { code: 7, report: PASS } : { code: 0, report: null };
    };
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(6);
    expect(testCalls).toHaveLength(2);
    expect(readSummary(root).status).toBe('infra_failed');
  });

  it('asserts the complete unity test argv with --format json before the -- tail', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    await runCommand(ctx, 'test');

    const args = testCalls[0]!;
    expect(args).toEqual([
      'test',
      root,
      '--mode',
      'EditMode',
      '--output',
      join(root, 'ci-output', 'tests', 'EditMode.xml'),
      '--report-format',
      'nunit,junit',
      '--junit-output',
      join(root, 'ci-output', 'tests', 'EditMode.junit.xml'),
      '--format',
      'json',
      '--',
      '-nographics',
    ]);
    // The literal `--` endures as the last separator and `--format` is a
    // CLI-level option immediately before it, never an Editor argument.
    expect(args.slice(-2)).toEqual(['--', '-nographics']);
    expect(args.indexOf('--format')).toBe(args.indexOf('--') - 2);
    expect(args.filter((arg) => arg === '--format')).toHaveLength(1);
  });

  it('does not pass -nographics for PlayMode', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.test.modes = ['PlayMode'];
    });

    await runCommand(ctx, 'test');

    expect(testCalls[0]).not.toContain('-nographics');
    expect(testCalls[0]).not.toContain('--');
  });

  it('reports total 0 and failed 0 only when a report really exists', async () => {
    const root = makeProject();
    responder = () => ({ code: 0, report: ZERO_TESTS });
    expect(await runCommand(makeContext(root), 'test')).toBe(0);
    const summary = readSummary(root);
    expect(summary.status).toBe('passed');
    expect(summary.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });

    // The same zero counts without a report are an infrastructure failure, never
    // a green suite.
    const emptyRoot = makeProject();
    responder = () => ({ code: 0, report: null });
    expect(await runCommand(makeContext(emptyRoot), 'test')).toBe(6);
    const empty = readSummary(emptyRoot);
    expect(empty.status).toBe('infra_failed');
    expect(empty.tests).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
  });

  it('writes summary.json with the documented schema', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    await runCommand(ctx, 'test');

    expect(existsSync(summaryPath(root))).toBe(true);
    const summary = readSummary(root);
    expect(Object.keys(summary).sort()).toEqual(
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
    expect(summary).toMatchObject({
      schema: 1,
      command: 'test',
      status: 'passed',
      exitCode: 0,
      unityExitCode: 0,
      attempts: 1,
      cliVersion: '1.0.0-beta.14',
      cliChannel: 'beta',
      cliCommit: 'abc1234',
      editorVersion: '6000.6.3f1',
      reports: {
        nunit: ['tests/EditMode.xml'],
        junit: ['tests/EditMode.junit.xml'],
      },
      license: { mode: 'serial', activated: true, returned: true, seatLeaked: false },
      artifacts: [],
      logs: { editor: null, cli: null },
    });
    expect(typeof summary.durationMs).toBe('number');
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never leaks the license serial into summary.json', async () => {
    const secret = 'run-test-serial-4f7c2d';
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
      config.license.serialEnv = 'UNITYCI_TEST_LICENSE_SERIAL';
    });
    ctx.env.UNITYCI_TEST_LICENSE_SERIAL = secret;
    ctx.redactor.register(secret);

    await runCommand(ctx, 'test');

    const file = readFileSync(summaryPath(root), 'utf8');
    expect(file).not.toContain(secret);
    expect(textOutput()).not.toContain(secret);
  });

  it('does not activate a license when the doctor gate fails, and still tears down', async () => {
    mocks.doctorCommand.mockImplementation(async () => {
      order.push('doctor');
      return 64;
    });
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(64);
    expect(order).toEqual(['doctor']);
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.activateLicense).not.toHaveBeenCalled();
    expect(licenseReturns).toHaveLength(0);
    expect(textOutput()).toContain('activated no license seat');
    expect(readSummary(root).status).toBe('config_error');
  });

  it('turns a licence activation failure into exit 64 and still tears down', async () => {
    mocks.activateLicense.mockImplementation(async () => {
      order.push('activate');
      throw new LicenseError('no serial in the environment', 64);
    });
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'test');

    expect(code).toBe(64);
    expect(order).toEqual(['doctor', 'setup', 'activate']);
    expect(licenseReturns).toHaveLength(0);
    expect(readSummary(root).status).toBe('config_error');
  });
});
