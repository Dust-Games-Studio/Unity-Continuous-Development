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

const mocks = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../src/exec.js', () => ({
  spawnProcess: mocks.spawnProcess,
}));

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
