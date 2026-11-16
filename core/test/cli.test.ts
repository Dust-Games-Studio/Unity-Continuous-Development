import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { licenseActivateCommand } from '../src/commands/license.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

const licenseMocks = vi.hoisted(() => ({
  activate: null as null | ((...args: any[]) => Promise<any>),
  return: null as null | ((...args: any[]) => Promise<any>),
}));
const reportMocks = vi.hoisted(() => ({
  impl: null as null | (() => Promise<number>),
}));

// Keep the real lifecycle by default, but let the signal and throw-path tests
// substitute one call. The run tests therefore still exercise the real
// `returnLicense` seat gate.
vi.mock('../src/lifecycle/license.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lifecycle/license.js')>();
  return {
    ...actual,
    activateLicense: (...args: Parameters<typeof actual.activateLicense>) =>
      licenseMocks.activate === null
        ? actual.activateLicense(...args)
        : licenseMocks.activate(...args),
    returnLicense: (...args: Parameters<typeof actual.returnLicense>) =>
      licenseMocks.return === null
        ? actual.returnLicense(...args)
        : licenseMocks.return(...args),
  };
});

// Only the unexpected-exception test uses this; every other command is real.
vi.mock('../src/commands/report.js', () => ({
  reportCommand: () =>
    reportMocks.impl === null ? Promise.resolve(0) : reportMocks.impl(),
}));

const FAKE_UNITY = fileURLToPath(
  new URL('../../testing/fake-unity/fake-unity.mjs', import.meta.url),
);
const PASS = readFileSync(new URL('./fixtures/editmode-pass.xml', import.meta.url), 'utf8');

const tempDirs: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  licenseMocks.activate = null;
  licenseMocks.return = null;
  reportMocks.impl = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stdout(): string {
  return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function stderr(): string {
  return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('');
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Shim {
  binary: string;
  env: Record<string, string>;
}

/**
 * A shim is the portable way to point `unity.cli.binary` at a Node script:
 * spawn() takes one executable and an argv array, so the script path cannot be
 * passed separately.
 *
 * POSIX gets a shell script with the exec bit. Windows cannot launch a `.cmd`
 * with `shell: false` (Node rejects it with EINVAL), so the binary is
 * `process.execPath` itself and a preload hook redirects Node's first entry
 * request to `fake-unity.mjs`, restoring the verb Node consumed as argv[1].
 */
function createShim(): Shim {
  const dir = tempDir('unityci-cli-shim-');
  if (process.platform !== 'win32') {
    const path = join(dir, 'unity');
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_UNITY}" "$@"\n`);
    chmodSync(path, 0o755);
    return { binary: path, env: {} };
  }

  const hook = join(dir, 'fake-unity-hook.cjs');
  writeFileSync(
    hook,
    `const Module = require('node:module');
const path = require('node:path');
const fake = ${JSON.stringify(FAKE_UNITY)};
const entryPath = process.argv[1];
const entryArg = path.basename(entryPath);
const original = Module._resolveFilename;
let redirected = false;
Module._resolveFilename = function (request, ...rest) {
  if (!redirected && request === entryPath) {
    redirected = true;
    return fake;
  }
  return original.call(this, request, ...rest);
};
process.argv[1] = fake;
process.argv.splice(2, 0, entryArg);
`,
  );
  const existing = process.env.NODE_OPTIONS;
  return {
    binary: process.execPath,
    env: {
      // Quote the path so a %TEMP% with spaces works; forward slashes keep Node
      // from stripping the Windows separators inside the quotes.
      NODE_OPTIONS: [existing, `--require "${hook.replace(/\\/g, '/')}"`]
        .filter(Boolean)
        .join(' '),
    },
  };
}

/** Stubs the shim's environment for the child process, restoring it after. */
function useShim(shim: Shim): void {
  for (const [name, value] of Object.entries(shim.env)) vi.stubEnv(name, value);
}

function writeProject(config: string): string {
  const root = tempDir('unityci-cli-project-');
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
  writeFileSync(
    join(root, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 6000.0.0f1\n',
  );
  writeFileSync(join(root, 'unity-ci.yml'), config);
  return root;
}

function writeScenario(scenario: unknown): string {
  const dir = tempDir('unityci-cli-scenario-');
  const path = join(dir, 'scenario.json');
  writeFileSync(path, JSON.stringify(scenario));
  return path;
}

function projectConfig(binary: string, extra = ''): string {
  return `unity:
  cli:
    binary: ${JSON.stringify(binary)}
  editor:
    version: 6000.0.0f1
    terms: false
license:
  mode: none
packages:
  preflight: false
doctor:
  minFreeBytes: 1
output:
  dir: ci-output
${extra}`;
}

function makeContext(root: string): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  config.license.mode = 'serial';
  const redactor = createRedactor();
  const logger = createLogger({ redactor, level: 'error', sink: () => {} });
  return {
    config,
    cwd: root,
    projectPath: root,
    env: {},
    logger,
    redactor,
    stdout: () => {},
    binary: 'unity',
    licenseActivated: false,
    startedAt: Date.now(),
    cliVersion: null,
    cliChannel: null,
    cliCommit: null,
  };
}

function runFake(
  args: string[],
  scenario: unknown,
): { status: number | null; stdout: string; stderr: string } {
  const scenarioPath = writeScenario(scenario);
  const result = spawnSync(process.execPath, [FAKE_UNITY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_UNITY_SCENARIO: scenarioPath },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('main', () => {
  it('exits 2 with usage for an unknown command', async () => {
    const code = await main(['frobnicate']);

    expect(code).toBe(2);
    expect(stderr()).toContain('unknown command "frobnicate"');
    expect(stderr()).toContain('Usage: unityci');
    expect(stdout()).toBe('');
  });

  it('exits 2 for an unknown option', async () => {
    const code = await main(['doctor', '--nope']);

    expect(code).toBe(2);
    expect(stderr()).toContain('--nope');
    expect(stdout()).toBe('');
  });

  it('exits 2 for run without a sub-command', async () => {
    const code = await main(['run']);

    expect(code).toBe(2);
    expect(stderr()).toContain('run requires one of test, build');
    expect(stderr()).toContain('Usage: unityci');
  });

  it('exits 2 for license without a sub-command', async () => {
    const code = await main(['license']);

    expect(code).toBe(2);
    expect(stderr()).toContain('license requires one of activate, return, status');
  });

  it('rejects --json on a command that has no JSON document', async () => {
    const code = await main(['doctor', '--json']);

    expect(code).toBe(2);
    expect(stderr()).toContain('option --json is not valid for doctor');
  });

  it('refuses a non-empty -- passthrough with exit 2', async () => {
    const code = await main(['cache-info', '--', '-debugCodeOptimization']);

    expect(code).toBe(2);
    expect(stderr()).toContain('not forwarded yet');
    expect(stderr()).toContain('test.nographics');
  });

  it('keeps the published bin as a shebang module that sets process.exitCode', () => {
    const bin = readFileSync(new URL('../src/bin.ts', import.meta.url), 'utf8');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { bin?: Record<string, string> };

    expect(bin.split(/\r?\n/, 1)[0]).toBe('#!/usr/bin/env node');
    expect(bin).toContain('process.exitCode = await main(process.argv.slice(2))');
    expect(bin).not.toContain('process.exit(');
    expect(cli).not.toContain('process.exit(');
    expect(cli).not.toContain('pathToFileURL');
    expect(packageJson.bin?.['unityci']).toBe('./dist/bin.js');
  });

  it('exits 0 for --version and prints the package version', async () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const code = await main(['--version']);

    expect(code).toBe(0);
    expect(stdout()).toContain(packageJson.version);
  });

  it('exits 64 for an invalid configuration, before running the command', async () => {
    const root = writeProject(`doctor:
  minFreeBytes: 0
`);

    const code = await main(['cache-info', '--json', '--project-path', root]);

    expect(code).toBe(64);
    expect(stderr()).toContain('doctor.minFreeBytes');
    expect(stdout()).toBe('');
  });

  it('lets run test write a config_error summary for an invalid configuration', async () => {
    const root = writeProject(`doctor:
  minFreeBytes: 0
`);

    const code = await main(['run', 'test', '--project-path', root]);

    expect(code).toBe(64);
    expect(stderr()).toContain('doctor.minFreeBytes');
    const summary = JSON.parse(
      readFileSync(join(root, 'ci-output', 'summary.json'), 'utf8'),
    ) as { command: string; status: string; exitCode: number };
    expect(summary.command).toBe('test');
    expect(summary.status).toBe('config_error');
    expect(summary.exitCode).toBe(64);
  });

  it('exits 0 for --help and prints usage', async () => {
    const code = await main(['--help']);

    expect(code).toBe(0);
    expect(stdout()).toContain('Usage: unityci');
    expect(stdout()).toContain('cache-info');
    expect(stdout()).toContain('license activate');
  });

  it('dispatches run test to the run command and writes summary.json', async () => {
    const shim = createShim();
    useShim(shim);
    const scenario = writeScenario({
      results: [
        {
          args: ['version'],
          code: 0,
          json: {
            success: true,
            data: { version: '1.0.1', channel: 'stable', commit: 'abc123' },
          },
        },
        {
          args: ['doctor', '--ci'],
          code: 0,
          json: { success: true, data: { verdict: 'pass', checks: [] } },
        },
        {
          args: ['projects', 'verify'],
          code: 0,
          json: { success: true, data: {} },
        },
        {
          args: ['license', 'status'],
          code: 0,
          json: {
            success: true,
            data: {
              active: true,
              licenses: [{ product: 'Unity Pro', type: 'serial' }],
            },
          },
        },
        {
          args: ['editors', '--installed'],
          code: 0,
          json: { success: true, data: [{ version: '6000.0.0f1' }] },
        },
        {
          args: ['test'],
          code: 0,
          json: { success: true, data: {} },
          files: { 'ci-output/tests/EditMode.xml': PASS },
        },
      ],
    });
    vi.stubEnv('FAKE_UNITY_SCENARIO', scenario);
    const root = writeProject(
      projectConfig(
        shim.binary,
        `test:
  modes: [EditMode]
  outputDir: ci-output/tests
`,
      ),
    );
    const listenersBefore = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    const onSpy = vi.spyOn(process, 'on');

    const code = await main(['run', 'test', '--project-path', root]);

    expect(stderr()).not.toContain('no scenario');
    expect(code, stderr()).toBe(0);
    const summary = JSON.parse(
      readFileSync(join(root, 'ci-output', 'summary.json'), 'utf8'),
    ) as { command: string; status: string; tests: { passed: number } };
    expect(summary.command).toBe('test');
    expect(summary.status).toBe('passed');
    expect(summary.tests.passed).toBeGreaterThan(0);

    // The run lifecycle is wrapped in the signal handlers and they are disposed.
    expect(onSpy.mock.calls.some(([event]) => event === 'SIGINT')).toBe(true);
    expect(onSpy.mock.calls.some(([event]) => event === 'SIGTERM')).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.sigterm);
  });

  it('uses the fake unity binary when the config points at it', async () => {
    const shim = createShim();
    useShim(shim);
    const scenario = writeScenario({
      results: [
        {
          args: ['cache', 'info'],
          code: 0,
          json: {
            success: true,
            data: { path: 'C:/fake/UnityHub/downloads' },
          },
        },
        {
          args: ['cache', 'key'],
          code: 0,
          json: { success: true, data: { key: 'fake-library-key' } },
        },
      ],
    });
    vi.stubEnv('FAKE_UNITY_SCENARIO', scenario);
    const root = writeProject(projectConfig(shim.binary));

    const code = await main(['cache-info', '--json', '--project-path', root]);

    expect(code, stderr()).toBe(0);
    const document = JSON.parse(stdout()) as {
      editor: { paths: string[]; key: string };
      library: { key: string; staticKey: string };
    };
    expect(document.editor.paths).toEqual(['C:/fake/UnityHub/downloads']);
    expect(document.library.key).toBe('fake-library-key');
    expect(document.library.staticKey).toContain('6000.0.0f1');
    // stderr is the log stream; stdout carries only the JSON document.
    expect(stdout().trim().startsWith('{')).toBe(true);
  });

  it('passes a command non-zero exit code through unchanged', async () => {
    const shim = createShim();
    useShim(shim);
    const scenario = writeScenario({
      results: [
        {
          args: ['version'],
          code: 7,
          json: {
            success: false,
            errors: [{ code: 'SERVICE_UNREACHABLE', message: 'licensing is down' }],
          },
        },
      ],
    });
    vi.stubEnv('FAKE_UNITY_SCENARIO', scenario);
    const root = writeProject(projectConfig(shim.binary));

    const code = await main(['doctor', '--project-path', root]);

    expect(code).toBe(7);
    expect(stderr()).toContain('could not read the Unity CLI identity');
  });

  it('turns an unexpected command exception into exit 65 with a redacted message', async () => {
    const secret = 'unexpected-throw-secret';
    vi.stubEnv('UNITY_LICENSE_SERIAL', secret);
    reportMocks.impl = async () => {
      throw new Error(`kaboom ${secret}`);
    };

    const code = await main(['report']);

    expect(code).toBe(65);
    expect(stderr()).toContain('unexpected error');
    expect(stderr()).toContain('***');
    expect(stderr()).not.toContain(secret);
  });

  it('records a successful license activation on the context', async () => {
    const root = tempDir('unityci-cli-license-');
    licenseMocks.activate = async () => ({ activated: true, mode: 'serial' });
    const ctx = makeContext(root);

    const code = await licenseActivateCommand(ctx);

    expect(code).toBe(0);
    expect(ctx.licenseActivated).toBe(true);
  });

  it('returns the seat when a signal interrupts license activate', async () => {
    const root = writeProject('');
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    licenseMocks.activate = async () => {
      startedResolve();
      await release;
      return { activated: true, mode: 'serial' };
    };
    const returnMock = vi.fn(async () => ({ returned: true, code: 0 }));
    licenseMocks.return = returnMock;
    let exitedWith: number | undefined;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        exitedWith = code;
      }) as unknown as typeof process.exit);
    const listenersBefore = process.listenerCount('SIGINT');

    const running = main(['license', 'activate', '--project-path', root]);
    await started;
    process.emit('SIGINT');
    await vi.waitFor(() => expect(exitedWith).toBe(130));

    expect(returnMock).toHaveBeenCalledWith(expect.anything(), { force: true });
    expect(exitSpy).toHaveBeenCalledWith(130);

    releaseResolve();
    await running;
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
  });

  it('keeps cache-info --json on stdout while warnings go to stderr', async () => {
    const shim = createShim();
    useShim(shim);
    const scenario = writeScenario({
      results: [
        {
          args: ['cache', 'info'],
          code: 6,
          json: {
            success: false,
            errors: [{ code: 'NO_CACHE', message: 'no download cache known' }],
          },
        },
        {
          args: ['cache', 'key'],
          code: 11,
          json: {
            success: false,
            errors: [{ code: 'NOT_A_PROJECT', message: 'no ProjectVersion.txt' }],
          },
        },
      ],
    });
    vi.stubEnv('FAKE_UNITY_SCENARIO', scenario);
    const root = writeProject(projectConfig(shim.binary));

    const code = await main(['cache-info', '--json', '--project-path', root]);

    expect(code).toBe(0);
    expect(() => JSON.parse(stdout())).not.toThrow();
    expect(stdout()).not.toContain('could not');
    expect(stderr()).toContain('could not read the Unity download cache');
    expect(stderr()).toContain('using the static key');
  });

  it('registers environment secrets before any output can contain them', async () => {
    const shim = createShim();
    useShim(shim);
    const secret = 'serial-that-must-never-be-printed';
    vi.stubEnv('UNITY_LICENSE_SERIAL', secret);
    const scenario = writeScenario({
      results: [
        {
          args: ['cache', 'info'],
          code: 0,
          json: { success: true, data: { path: `C:/cache/${secret}` } },
        },
        {
          args: ['cache', 'key'],
          code: 0,
          json: { success: true, data: { key: `library-${secret}` } },
        },
      ],
    });
    vi.stubEnv('FAKE_UNITY_SCENARIO', scenario);
    const root = writeProject(projectConfig(shim.binary));

    const code = await main(['cache-info', '--json', '--project-path', root]);

    expect(code).toBe(0);
    expect(stdout()).not.toContain(secret);
    expect(stdout()).toContain('***');
  });
});

describe('fake-unity', () => {
  it('refuses a non-integer code instead of reporting success', () => {
    const result = runFake(['test'], {
      results: [{ args: ['test'], code: '8', json: { success: true } }],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('non-integer');
    expect(result.stderr).toContain('results[0]');
  });

  it('refuses a missing code instead of assuming 0', () => {
    const result = runFake(['test'], {
      results: [{ args: ['test'], json: { success: true } }],
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('has no "code"');
  });

  it('names the scenario file when the scenario cannot be parsed', () => {
    const dir = tempDir('unityci-cli-bad-scenario-');
    const path = join(dir, 'scenario.json');
    writeFileSync(path, '{ not json');
    const result = spawnSync(process.execPath, [FAKE_UNITY, 'test'], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_UNITY_SCENARIO: path },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(path);
  });
});
