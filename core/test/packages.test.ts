import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';
import {
  isGitDependencyUrl,
  readGitDependencies,
  redactGitUrl,
  type GitDependency,
} from '../src/packages/deps.js';
import { preflightGitDependencies } from '../src/packages/git.js';
import {
  hostPlatform,
  isBuildTargetSupportedOnHost,
  modulesForBuildTarget,
  modulesForTestMode,
} from '../src/packages/modules.js';

const mocks = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../src/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/exec.js')>();
  return { ...actual, spawnProcess: mocks.spawnProcess };
});

import { stripSensitiveEnv } from '../src/exec.js';

const FIXTURE = new URL('./fixtures/manifest-git-deps.json', import.meta.url);
const tempDirs: string[] = [];
const CWD = process.cwd();

function harness() {
  const redactor = createRedactor();
  const logger = createLogger({ redactor, level: 'debug', sink: () => {} });
  return { logger, redactor };
}

function project(manifest?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-packages-'));
  tempDirs.push(dir);
  if (manifest !== undefined) {
    mkdirSync(join(dir, 'Packages'), { recursive: true });
    writeFileSync(
      join(dir, 'Packages', 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  }
  return dir;
}

function projectFromFixture(): string {
  const dir = project();
  mkdirSync(join(dir, 'Packages'), { recursive: true });
  writeFileSync(join(dir, 'Packages', 'manifest.json'), readFileSync(FIXTURE));
  return dir;
}

function ok() {
  return { code: 0, stdout: '', stderr: '', rawStdout: '', rawStderr: '' };
}

function dependency(overrides: Partial<GitDependency> = {}): GitDependency {
  return {
    name: 'com.example.private',
    url: 'https://github.com/example/private.git',
    host: 'github.com',
    hasEmbeddedCredentials: false,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.spawnProcess.mockReset();
  mocks.spawnProcess.mockResolvedValue(ok());
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('readGitDependencies', () => {
  it('reads git dependencies from Packages/manifest.json', () => {
    const deps = readGitDependencies(projectFromFixture());

    expect(deps.map((dep) => dep.name).sort()).toEqual([
      'com.example.public',
      'com.example.scp',
      'com.example.ssh',
    ]);
    expect(deps.find((dep) => dep.name === 'com.example.public')).toMatchObject({
      url: 'https://github.com/example/public.git',
      host: 'github.com',
      hasEmbeddedCredentials: false,
    });
  });

  it('reads a dependency written as git@github.com:owner/repo.git', () => {
    const deps = readGitDependencies(projectFromFixture());
    const scp = deps.find((dep) => dep.name === 'com.example.scp');

    expect(scp).toMatchObject({
      url: 'git@github.com:example/scp.git',
      host: 'github.com',
      hasEmbeddedCredentials: false,
    });
  });

  it('reads a dependency written as ssh://git@host/owner/repo.git', () => {
    const deps = readGitDependencies(projectFromFixture());
    const ssh = deps.find((dep) => dep.name === 'com.example.ssh');

    expect(ssh).toMatchObject({
      url: 'ssh://git@github.com/example/ssh.git',
      host: 'github.com',
      // The `git` user is part of SSH's syntax, not a secret.
      hasEmbeddedCredentials: false,
    });
  });

  it('ignores registry dependencies', () => {
    const deps = readGitDependencies(projectFromFixture());

    expect(deps.map((dep) => dep.name)).not.toContain('com.unity.ugui');
    expect(isGitDependencyUrl('com.unity.ugui')).toBe(false);
    expect(isGitDependencyUrl('1.0.0')).toBe(false);
  });

  it('ignores a scoped registry dependency', () => {
    const deps = readGitDependencies(projectFromFixture());

    expect(deps.map((dep) => dep.name)).not.toContain('com.example.registry');
    expect(isGitDependencyUrl('https://packages.unity.com/com.example.registry')).toBe(false);
    // A `.git` URL with Unity's `?path=` suffix is still a git dependency.
    expect(isGitDependencyUrl('https://github.com/example/mono.git?path=/packages/x')).toBe(true);
    expect(isGitDependencyUrl('https://github.com/example/mono.git#v1.2.3')).toBe(true);
  });

  it('detects embedded credentials in a URL', () => {
    const dir = project({
      dependencies: {
        'com.example.leaky': 'https://user:token@github.com/example/leaky.git',
        'com.example.token': 'https://token@github.com/example/token.git',
      },
    });

    const deps = readGitDependencies(dir);

    expect(deps.find((dep) => dep.name === 'com.example.leaky')?.hasEmbeddedCredentials).toBe(true);
    expect(deps.find((dep) => dep.name === 'com.example.token')?.hasEmbeddedCredentials).toBe(true);
    expect(deps.every((dep) => dep.host === 'github.com')).toBe(true);
  });

  it('redacts credentials before a URL reaches a log or a report', () => {
    const redacted = redactGitUrl('https://user:token@github.com/example/leaky.git');

    expect(redacted).not.toContain('token');
    expect(redacted).not.toContain('user');
    expect(redacted).toBe('https://***@github.com/example/leaky.git');
  });

  it('returns an empty list for a project with no manifest', () => {
    expect(readGitDependencies(project())).toEqual([]);
  });

  it('reads the resolved git set from packages-lock.json when the manifest lacks it', () => {
    const dir = project({ dependencies: {} });
    writeFileSync(
      join(dir, 'Packages', 'packages-lock.json'),
      JSON.stringify({
        dependencies: {
          'com.example.transitive': {
            version: 'https://github.com/example/transitive.git',
            source: 'git',
          },
        },
      }),
      'utf8',
    );

    expect(readGitDependencies(dir)).toEqual([
      {
        name: 'com.example.transitive',
        url: 'https://github.com/example/transitive.git',
        host: 'github.com',
        hasEmbeddedCredentials: false,
      },
    ]);
  });
});

describe('preflightGitDependencies', () => {
  it('runs git ls-remote --exit-code once per unique repository URL', async () => {
    const deps = [
      dependency({ name: 'com.example.one' }),
      dependency({ name: 'com.example.two' }),
      dependency({ name: 'com.example.three', url: 'https://github.com/example/three.git' }),
    ];
    const calls: string[][] = [];
    mocks.spawnProcess.mockImplementation(async (options: { args: string[] }) => {
      calls.push(options.args);
      return ok();
    });

    const results = await preflightGitDependencies(deps, {
      cwd: CWD,
      env: {},
      ...harness(),
    });

    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['ls-remote', '--exit-code']);
    }
    expect(calls.map((args) => args[2])).toEqual([
      'https://github.com/example/private.git',
      'https://github.com/example/three.git',
    ]);
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.reachable)).toBe(true);
  });

  it('reports the exit code and stderr when a repository is not fetchable', async () => {
    mocks.spawnProcess.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'fatal: repository not found\n',
      rawStdout: '',
      rawStderr: 'fatal: repository not found\n',
    });

    const [result] = await preflightGitDependencies([dependency()], {
      cwd: CWD,
      env: {},
      ...harness(),
    });

    expect(result?.reachable).toBe(false);
    expect(result?.detail).toContain('128');
    expect(result?.detail).toContain('repository not found');
  });

  it('never contacts a URL that embeds credentials', async () => {
    const [result] = await preflightGitDependencies(
      [dependency({ hasEmbeddedCredentials: true })],
      { cwd: CWD, env: {}, ...harness() },
    );

    expect(mocks.spawnProcess).not.toHaveBeenCalled();
    expect(result?.reachable).toBe(false);
    expect(result?.detail).toMatch(/credentials/);
  });
});

describe('modulesForBuildTarget', () => {
  it('maps native builds to no player module', () => {
    expect(modulesForBuildTarget('StandaloneWindows64', 'windows')).toEqual([]);
    expect(modulesForBuildTarget('StandaloneLinux64', 'linux')).toEqual([]);
    expect(modulesForBuildTarget('StandaloneOSX', 'macos')).toEqual(['mac-mono']);
  });

  it('requires the target player module for a cross-build', () => {
    expect(modulesForBuildTarget('StandaloneWindows64', 'linux')).toEqual([
      'windows-il2cpp',
    ]);
    expect(modulesForBuildTarget('StandaloneWindows64', 'macos')).toEqual([
      'windows-il2cpp',
    ]);
    expect(modulesForBuildTarget('StandaloneLinux64', 'windows')).toEqual([
      'linux-il2cpp',
    ]);
    expect(modulesForBuildTarget('StandaloneLinux64', 'macos')).toEqual([
      'linux-il2cpp',
    ]);
  });

  it('maps the platform modules every host needs', () => {
    for (const host of ['windows', 'macos', 'linux'] as const) {
      expect(modulesForBuildTarget('Android', host)).toEqual([
        'android',
        'android-sdk-ndk-tools',
      ]);
      expect(modulesForBuildTarget('WebGL', host)).toEqual(['webgl']);
      expect(modulesForBuildTarget('WindowsStoreApps', host)).toEqual([
        'universal-windows-platform',
      ]);
      expect(modulesForBuildTarget('LinuxServer', host)).toEqual(['linux-server']);
    }
  });

  it('maps the macOS-only targets to their modules on macOS', () => {
    expect(modulesForBuildTarget('iOS', 'macos')).toEqual(['ios']);
    expect(modulesForBuildTarget('tvOS', 'macos')).toEqual(['appletv']);
    expect(modulesForBuildTarget('visionOS', 'macos')).toEqual(['visionos']);
    expect(modulesForBuildTarget('MacServer', 'macos')).toEqual(['mac-server']);
  });

  it('returns an empty list for an unknown target or an unsupported host', () => {
    expect(modulesForBuildTarget('PlayStation9', 'linux')).toEqual([]);
    expect(modulesForBuildTarget('iOS', 'linux')).toEqual([]);
  });

  it('returns a copy, so a caller cannot mutate the table', () => {
    const modules = modulesForBuildTarget('Android', 'linux');
    modules.push('mutated');
    expect(modulesForBuildTarget('Android', 'linux')).toEqual([
      'android',
      'android-sdk-ndk-tools',
    ]);
  });

  it('requires no platform module for EditMode or PlayMode', () => {
    expect(modulesForTestMode('EditMode')).toEqual([]);
    expect(modulesForTestMode('PlayMode')).toEqual([]);
    expect(modulesForTestMode('UnknownMode')).toEqual([]);
  });
});

describe('isBuildTargetSupportedOnHost', () => {
  it('allows Windows, Linux, Android and WebGL from every host', () => {
    for (const host of ['windows', 'macos', 'linux'] as const) {
      for (const target of [
        'StandaloneWindows64',
        'StandaloneLinux64',
        'Android',
        'WebGL',
        'WindowsStoreApps',
        'LinuxServer',
      ]) {
        expect(isBuildTargetSupportedOnHost(target, host)).toEqual({ supported: true });
      }
    }
  });

  it('requires macOS for macOS, iOS, tvOS, visionOS and MacServer targets', () => {
    for (const target of [
      'StandaloneOSX',
      'iOS',
      'tvOS',
      'visionOS',
      'MacServer',
    ]) {
      expect(isBuildTargetSupportedOnHost(target, 'macos')).toEqual({ supported: true });
      for (const host of ['windows', 'linux'] as const) {
        const result = isBuildTargetSupportedOnHost(target, host);
        expect(result.supported).toBe(false);
        expect(result.reason).toContain('macOS');
      }
    }
  });

  it('leaves an unknown target to the Editor', () => {
    expect(isBuildTargetSupportedOnHost('PlayStation9', 'linux')).toEqual({
      supported: true,
    });
  });
});

describe('hostPlatform', () => {
  it('returns one of the three supported hosts', () => {
    expect(['windows', 'macos', 'linux']).toContain(hostPlatform());
  });
});

describe('stripSensitiveEnv', () => {
  it('removes Unity service-account and forge tokens from every child env', () => {
    const env = stripSensitiveEnv({
      PATH: '/bin',
      UNITY_SERVICE_ACCOUNT_ID: 'id',
      UNITY_SERVICE_ACCOUNT_SECRET: 'secret',
      UNITY_GITHUB_TOKEN: 'github',
      UNITY_GITLAB_TOKEN: 'gitlab',
      UNITY_LICENSE_SERIAL: 'serial',
    });

    expect(env['PATH']).toBe('/bin');
    expect(env['UNITY_LICENSE_SERIAL']).toBe('serial');
    for (const name of [
      'UNITY_SERVICE_ACCOUNT_ID',
      'UNITY_SERVICE_ACCOUNT_SECRET',
      'UNITY_GITHUB_TOKEN',
      'UNITY_GITLAB_TOKEN',
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });

  it('strips the tokens from a real child process started by spawnProcess', async () => {
    const actual = await vi.importActual<typeof import('../src/exec.js')>(
      '../src/exec.js',
    );
    const result = await actual.spawnProcess({
      file: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ id: process.env.UNITY_SERVICE_ACCOUNT_ID ?? null, github: process.env.UNITY_GITHUB_TOKEN ?? null, serial: process.env.UNITY_LICENSE_SERIAL ?? null }))',
      ],
      cwd: CWD,
      env: {
        ...process.env,
        UNITY_SERVICE_ACCOUNT_ID: 'service-id',
        UNITY_SERVICE_ACCOUNT_SECRET: 'service-secret',
        UNITY_GITHUB_TOKEN: 'github-token',
        UNITY_GITLAB_TOKEN: 'gitlab-token',
        UNITY_LICENSE_SERIAL: 'serial-passthrough',
      },
      ...harness(),
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: null,
      github: null,
      serial: 'serial-passthrough',
    });
  });
});



