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
      // NODE_OPTIONS strips backslashes inside quotes, so use forward slashes
      // and leave the path unquoted (the temp directory has no spaces here).
      NODE_OPTIONS: [existing, `--require ${hook.replace(/\\/g, '/')}`]
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

describe('main', () => {
  it('exits 2 with usage for an unknown command', async () => {
    const code = await main(['frobnicate']);

    expect(code).toBe(2);
    expect(stderr()).toContain('unknown command "frobnicate"');
    expect(stderr()).toContain('Usage: unityci');
    expect(stdout()).toBe('');
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
            data: { version: '1.0.0-beta.14', channel: 'beta', commit: 'abc123' },
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
