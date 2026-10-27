import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../src/exit-codes.js';
import { spawnProcess } from '../src/exec.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';
import type { UnityBaseOptions } from '../src/unity/cli.js';
import { runUnity } from '../src/unity/exec.js';

const CWD = process.cwd();

interface Harness {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
  redactor: ReturnType<typeof createRedactor>;
}

function harness(): Harness {
  const lines: string[] = [];
  const redactor = createRedactor();
  const logger = createLogger({
    redactor,
    level: 'debug',
    sink: (line) => {
      lines.push(line);
    },
  });
  return { lines, logger, redactor };
}

/** The tokens are deliberately hostile: a shell would split or reinterpret them. */
const HOSTILE_ARGS = [
  'plain',
  'with space',
  '--flag=a;b',
  '"double quoted"',
  "'single quoted'",
  '$(echo injected)',
  '`echo injected`',
  '*',
  'back\\slash',
  '--format=json',
];

function nodeArgs(script: string, ...tokens: string[]): string[] {
  return ['-e', script, ...tokens];
}

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  vi.restoreAllMocks();
});

describe('spawnProcess', () => {
  it('spawns the binary with an argv array and no shell', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    const spawnMock = vi.fn(
      (_file: string, _args: string[], _options: Record<string, unknown>) => {
        queueMicrotask(() => {
          child.stdout.emit('data', '{"ok":true}');
          child.emit('close', 0, null);
        });
        return child;
      },
    );

    vi.resetModules();
    vi.doMock('node:child_process', () => ({ spawn: spawnMock }));

    const env = { PATH: process.env.PATH ?? '', PROBE: 'value' };
    const { logger, redactor } = harness();
    let result: { code: number; stdout: string; stderr: string } | undefined;
    try {
      const { spawnProcess: spawnWithMock } = await import('../src/exec.js');
      result = await spawnWithMock({
        file: 'unity',
        args: ['version', '--format', 'json'],
        cwd: CWD,
        env,
        logger,
        redactor,
      });
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0];
    expect(call).toBeDefined();
    const [file, args, options] = call!;

    expect(file).toBe('unity');
    // Never a command string: a string would let a shell split or reinterpret it.
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['version', '--format', 'json']);
    expect(options).toMatchObject({
      cwd: CWD,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(options.env).toEqual(env);
    expect(result?.code).toBe(0);
  });

  it('keeps every argv token intact, including spaces, quotes and shell metacharacters', async () => {
    const { logger, redactor } = harness();
    const result = await spawnProcess({
      file: process.execPath,
      args: nodeArgs('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...HOSTILE_ARGS),
      cwd: CWD,
      env: {},
      logger,
      redactor,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(HOSTILE_ARGS);
  });

  it('propagates the child exit code', async () => {
    const { logger, redactor } = harness();
    const result = await spawnProcess({
      file: process.execPath,
      args: nodeArgs('process.exit(8)'),
      cwd: CWD,
      env: {},
      logger,
      redactor,
    });

    expect(result.code).toBe(8);
  });

  it('redacts a registered secret found in the child stdout and stderr', async () => {
    const { logger, redactor, lines } = harness();
    const secret = 'hunter2-super-secret';
    redactor.register(secret);

    const result = await spawnProcess({
      file: process.execPath,
      args: nodeArgs(
        `process.stdout.write(${JSON.stringify(`serial=${secret}`)});` +
          `process.stderr.write(${JSON.stringify(`error ${secret}`)});`,
      ),
      cwd: CWD,
      env: {},
      logger,
      redactor,
    });

    expect(result.stdout).toBe('serial=***');
    expect(result.stderr).toBe('error ***');
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    // Streaming output is redacted too, not only the returned strings.
    expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).toContain('***');
  });

  it('kills the child and returns 14 when the timeout elapses', async () => {
    const { logger, redactor } = harness();
    const started = Date.now();
    const result = await spawnProcess({
      file: process.execPath,
      args: nodeArgs('setTimeout(() => {}, 60000)'),
      cwd: CWD,
      env: {},
      logger,
      redactor,
      timeoutMs: 300,
    });

    expect(result.code).toBe(EXIT.TIMEOUT);
    // The child was spawned with a 60 s sleep; returning quickly proves the kill.
    expect(Date.now() - started).toBeLessThan(10000);
  });
});

describe('runUnity', () => {
  function unityOpts(script: string, overrides: Partial<UnityBaseOptions> = {}) {
    const { logger, redactor } = harness();
    return {
      binary: process.execPath,
      args: nodeArgs(script),
      cwd: CWD,
      env: {},
      logger,
      redactor,
      ...overrides,
    };
  }

  it('parses stdout as JSON when --format json was requested', async () => {
    const result = await runUnity(
      unityOpts(
        'process.stdout.write(JSON.stringify({ success: true, data: { version: "1.0.0-beta.14" } }))',
      ),
    );

    expect(result.code).toBe(0);
    expect(result.json).toEqual({ success: true, data: { version: '1.0.0-beta.14' } });
  });

  it('returns json: null when stdout is not JSON', async () => {
    const result = await runUnity(unityOpts('process.stdout.write("not json at all")'));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('not json at all');
    expect(result.json).toBeNull();
  });

  it('returns json: null when stdout is empty', async () => {
    const result = await runUnity(unityOpts('process.exit(0)'));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.json).toBeNull();
  });

  it('passes the always-on Unity variables and strips the four token variables', async () => {
    setEnv('UNITY_SERVICE_ACCOUNT_ID', 'service-account-id');
    setEnv('UNITY_SERVICE_ACCOUNT_SECRET', 'service-account-secret');
    setEnv('UNITY_GITHUB_TOKEN', 'github-token');
    setEnv('UNITY_GITLAB_TOKEN', 'gitlab-token');
    setEnv('UNITY_LICENSE_SERIAL', 'serial-from-ambient-env');

    const script = `
      const e = process.env;
      process.stdout.write(JSON.stringify({
        nonInteractive: e.UNITY_NON_INTERACTIVE ?? null,
        noUpdateCheck: e.UNITY_NO_UPDATE_CHECK ?? null,
        noBanner: e.UNITY_NO_BANNER ?? null,
        noAgentHints: e.UNITY_NO_AGENT_HINTS ?? null,
        noTelemetry: e.UNITY_NO_CLI_INVOKED_TELEMETRY ?? null,
        crashReport: e.UNITY_NO_CRASH_REPORT ?? null,
        serviceAccountId: e.UNITY_SERVICE_ACCOUNT_ID ?? null,
        serviceAccountSecret: e.UNITY_SERVICE_ACCOUNT_SECRET ?? null,
        githubToken: e.UNITY_GITHUB_TOKEN ?? null,
        gitlabToken: e.UNITY_GITLAB_TOKEN ?? null,
        licenseSerial: e.UNITY_LICENSE_SERIAL ?? null,
        merged: e.UNITYCI_EXEC_TEST_VALUE ?? null,
      }));
    `;

    const result = await runUnity(
      unityOpts(script, {
        // The caller's additions survive; its attempts to re-add a token or
        // override an always-on variable do not.
        env: {
          UNITY_NO_CRASH_REPORT: '1',
          UNITYCI_EXEC_TEST_VALUE: 'from-opts-env',
          UNITY_SERVICE_ACCOUNT_SECRET: 'resurrected-by-caller',
          UNITY_NON_INTERACTIVE: '0',
        },
      }),
    );

    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      nonInteractive: '1',
      noUpdateCheck: '1',
      noBanner: '1',
      noAgentHints: '1',
      noTelemetry: '1',
      crashReport: '1',
      serviceAccountId: null,
      serviceAccountSecret: null,
      githubToken: null,
      gitlabToken: null,
      licenseSerial: 'serial-from-ambient-env',
      merged: 'from-opts-env',
    });
  });

  it('kills the child and returns 14 when the timeout elapses', async () => {
    const result = await runUnity(
      unityOpts('setTimeout(() => {}, 60000)', { timeoutMs: 300 }),
    );

    expect(result.code).toBe(EXIT.TIMEOUT);
  });
});

describe('unity CLI wrappers', () => {
  it('builds an argv array for every wrapper, and every wrapper requests --format json', async () => {
    const calls: string[][] = [];

    vi.resetModules();
    vi.doMock('../src/unity/exec.js', () => ({
      runUnity: vi.fn(async (opts: { args: string[] }) => {
        calls.push(opts.args);
        return { code: 0, stdout: '', stderr: '', json: null };
      }),
    }));

    const { logger, redactor } = harness();
    const base = { binary: 'unity', cwd: CWD, env: {}, logger, redactor };
    try {
      const cli = await import('../src/unity/cli.js');
      await cli.unityVersion(base);
      await cli.unityDoctorCi(base);
      await cli.unityInstall(base, {
        version: '6000.0.47f1',
        modules: ['android', 'webgl'],
        childModules: false,
        changeset: 'abc123',
        architecture: 'x86_64',
        acceptEula: true,
      });
      await cli.unityInstall(base, { version: '6000.0.47f1' });
      await cli.unityTermsAccept(base, '6000.0.47f1');
      await cli.unityLicenseActivate(base, ['--floating', '--file', 'license.ulf']);
      await cli.unityLicenseReturn(base);
      await cli.unityTest(base, ['--mode', 'EditMode', '--output', 'ci-output/tests/EditMode.xml']);
      await cli.unityBuild(base, ['--target', 'WebGL', '--output-path', 'ci-output/build/web']);
      await cli.unityCacheKey(base, '/project', 'WebGL');
      await cli.unityCacheKey(base, '/project');
      await cli.unityCacheInfo(base);
      await cli.unityProjectsVerify(base, '/project');
      await cli.unityEditorsInstalled(base);
    } finally {
      vi.doUnmock('../src/unity/exec.js');
      vi.resetModules();
    }

    expect(calls).toEqual([
      ['version', '--format', 'json'],
      ['doctor', '--ci', '--format', 'json'],
      [
        'install',
        '6000.0.47f1',
        '--module',
        'android',
        'webgl',
        '--no-cm',
        '--changeset',
        'abc123',
        '--architecture',
        'x86_64',
        '--yes',
        '--accept-eula',
        '--format',
        'json',
      ],
      ['install', '6000.0.47f1', '--yes', '--format', 'json'],
      ['terms', 'accept', '6000.0.47f1', '--yes', '--format', 'json'],
      ['license', 'activate', '--floating', '--file', 'license.ulf', '--format', 'json'],
      ['license', 'return', '--yes', '--format', 'json'],
      [
        'test',
        '--mode',
        'EditMode',
        '--output',
        'ci-output/tests/EditMode.xml',
        '--format',
        'json',
      ],
      ['build', '--target', 'WebGL', '--output-path', 'ci-output/build/web', '--format', 'json'],
      ['cache', 'key', '/project', '--target', 'WebGL', '--format', 'json'],
      ['cache', 'key', '/project', '--format', 'json'],
      ['cache', 'info', '--format', 'json'],
      ['projects', 'verify', '/project', '--strict', '--format', 'json'],
      ['editors', '--installed', '--format', 'json'],
    ]);

    // No wrapper may ever pass a single concatenated command string.
    for (const args of calls) {
      expect(Array.isArray(args)).toBe(true);
      expect(args.every((token) => typeof token === 'string')).toBe(true);
      expect(args[0]).not.toContain(' ');
    }
  });

  it('exports the tested CLI range', async () => {
    const cli = await import('../src/unity/cli.js');
    expect(cli.TESTED_CLI_MIN).toBe('1.0.0-beta.9');
    expect(cli.TESTED_CLI_MAX).toBe('1.0.0-beta.14');
  });

  it('uses --cm when child modules are requested and omits it when unset', async () => {
    const calls: string[][] = [];

    vi.resetModules();
    vi.doMock('../src/unity/exec.js', () => ({
      runUnity: vi.fn(async (opts: { args: string[] }) => {
        calls.push(opts.args);
        return { code: 0, stdout: '', stderr: '', json: null };
      }),
    }));

    const { logger, redactor } = harness();
    const base = { binary: 'unity', cwd: CWD, env: {}, logger, redactor };
    try {
      const cli = await import('../src/unity/cli.js');
      await cli.unityInstall(base, { version: '6000.0.47f1', childModules: true });
      await cli.unityInstall(base, { version: '6000.0.47f1', childModules: undefined });
    } finally {
      vi.doUnmock('../src/unity/exec.js');
      vi.resetModules();
    }

    expect(calls[0]).toContain('--cm');
    expect(calls[0]).not.toContain('--no-cm');
    expect(calls[1]).not.toContain('--cm');
    expect(calls[1]).not.toContain('--no-cm');
  });
});
