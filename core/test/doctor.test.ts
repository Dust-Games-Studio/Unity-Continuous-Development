import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/commands/doctor.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

const mocks = vi.hoisted(() => ({
  runUnity: vi.fn(),
  spawnProcess: vi.fn(),
}));

vi.mock('../src/unity/exec.js', () => ({
  runUnity: mocks.runUnity,
}));

vi.mock('../src/exec.js', () => ({
  spawnProcess: mocks.spawnProcess,
}));

interface Scenario {
  version?: string;
  doctor?: unknown;
  doctorCode?: number;
  doctorSuccess?: boolean;
  verify?: unknown;
  verifyCode?: number;
  license?: unknown;
  licenseCode?: number;
}

const calls: string[][] = [];
const lines: string[] = [];
const tempDirs: string[] = [];
let scenario: Scenario = {};

function envelope(data: unknown, code = 0, success = true) {
  return { code, stdout: '', stderr: '', json: { success, data } };
}

function failure(code: number, stderr: string, data?: unknown) {
  return {
    code,
    stdout: '',
    stderr,
    json: data === undefined ? null : { success: false, data },
  };
}

function defaultDoctor(): unknown {
  return {
    verdict: 'pass',
    checks: [
      { id: 'machine', status: 'pass', code: 'OK', blocking: true, message: 'machine ready' },
    ],
  };
}

function defaultLicense(): unknown {
  return { active: true, licenses: [{ product: 'Unity Personal', type: 'Assigned' }], floatingServer: null };
}

function responder(args: string[]) {
  if (args[0] === 'version') {
    return envelope({
      version: scenario.version ?? '1.0.0-beta.14',
      channel: 'beta',
      commit: 'cli-commit-abc',
    });
  }
  if (args[0] === 'doctor') {
    return envelope(
      scenario.doctor ?? defaultDoctor(),
      scenario.doctorCode ?? 0,
      scenario.doctorSuccess ?? true,
    );
  }
  if (args[0] === 'projects') {
    return envelope(scenario.verify ?? { errors: [] }, scenario.verifyCode ?? 0);
  }
  if (args[0] === 'license') {
    const code = scenario.licenseCode ?? 0;
    return code === 0
      ? envelope(scenario.license ?? defaultLicense())
      : failure(code, 'license command failed', scenario.license ?? { active: false });
  }
  return envelope({});
}

function makeProject(manifest?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-doctor-'));
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

function makeContext(projectPath: string, edit?: (config: Config) => void): CoreContext {
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
    cwd: projectPath,
    projectPath,
    env: {},
    logger,
    redactor,
    binary: 'unity',
    startedAt: Date.now(),
    cliVersion: null,
    cliChannel: null,
    cliCommit: null,
  };
}

function reportPath(project: string): string {
  return join(project, 'ci-output', 'logs', 'doctor.json');
}

function readReport(project: string): {
  verdict: string;
  checks: { id: string; status: string; blocking: boolean }[];
  gitDependencies: { name: string; url: string; host: string; reachable: boolean }[];
} {
  return JSON.parse(readFileSync(reportPath(project), 'utf8')) as never;
}

function gitOk() {
  return { code: 0, stdout: '', stderr: '', rawStdout: '', rawStderr: '' };
}

beforeEach(() => {
  scenario = {};
  calls.length = 0;
  lines.length = 0;
  mocks.runUnity.mockReset();
  mocks.spawnProcess.mockReset();
  mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
    calls.push(options.args);
    return responder(options.args);
  });
  mocks.spawnProcess.mockResolvedValue(gitOk());
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('doctorCommand', () => {
  it('exits 0 and reports pass when every blocking check passes', async () => {
    const project = makeProject();
    const ctx = makeContext(project);

    const code = await doctorCommand(ctx);

    expect(code).toBe(0);
    expect(readReport(project).verdict).toBe('pass');
    expect(lines.join('')).toContain('PASS machine');
  });

  it('exits non-zero when a blocking check fails', async () => {
    scenario.doctor = {
      verdict: 'fail',
      checks: [
        {
          id: 'entitlement',
          status: 'fail',
          code: 'EDITOR_NOT_ENTITLED',
          blocking: true,
          message: 'the machine is not entitled to run the Editor',
        },
      ],
    };
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).not.toBe(0);
    expect(code).toBe(64);
    expect(lines.join('')).toContain('EDITOR_NOT_ENTITLED');
    expect(readReport(project).verdict).toBe('fail');
  });

  it('writes the doctor report to ci-output/logs/doctor.json', async () => {
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    expect(existsSync(reportPath(project))).toBe(true);
    const report = readReport(project);
    expect(report.checks.some((check) => check.id === 'machine')).toBe(true);
    expect(report.checks.some((check) => check.id === 'projects-verify')).toBe(true);
  });

  it('does not fail the run on a non-blocking failing check', async () => {
    scenario.doctor = {
      verdict: 'fail',
      checks: [
        { id: 'machine', status: 'pass', code: 'OK', blocking: true, message: 'ready' },
        {
          id: 'disk-space',
          status: 'fail',
          code: 'LOW_DISK',
          blocking: false,
          message: 'only 2 GiB free',
        },
      ],
    };
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    expect(readReport(project).verdict).toBe('pass');
  });

  it('runs unity projects verify and reports project integrity problems', async () => {
    scenario.verifyCode = 6;
    scenario.verify = {
      errors: [{ code: 'MISSING_META', message: 'Assets/Foo.cs has no .meta file' }],
    };
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).not.toBe(0);
    expect(calls.some((args) => args[0] === 'projects' && args.includes('--strict'))).toBe(true);
    expect(lines.join('')).toContain('MISSING_META');
    expect(readReport(project).checks.find((check) => check.id === 'projects-verify')?.status).toBe(
      'fail',
    );
  });

  it('warns but does not fail when the CLI is newer than the tested ceiling', async () => {
    scenario.version = '1.0.0-beta.20';
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    expect(lines.join('')).toContain('1.0.0-beta.14');
    expect(lines.join('')).toMatch(/newer than the tested ceiling/);
  });

  it('fails with exit 64 when the CLI is older than the tested floor', async () => {
    scenario.version = '1.0.0-beta.8';
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    expect(lines.join('')).toContain('1.0.0-beta.9');
  });

  it('records the CLI version, channel and commit on the context', async () => {
    const project = makeProject();
    const ctx = makeContext(project);

    const code = await doctorCommand(ctx);

    expect(code).toBe(0);
    expect(ctx.cliVersion).toBe('1.0.0-beta.14');
    expect(ctx.cliChannel).toBe('beta');
    expect(ctx.cliCommit).toBe('cli-commit-abc');
  });

  it('reports the git package dependencies and their hosts', async () => {
    const project = makeProject({
      dependencies: {
        'com.example.one': 'https://github.com/example/one.git',
        'com.example.two': 'git@gitlab.com:example/two.git',
      },
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    const deps = readReport(project).gitDependencies;
    expect(deps.map((dep) => dep.name).sort()).toEqual(['com.example.one', 'com.example.two']);
    expect(deps.map((dep) => dep.host).sort()).toEqual(['github.com', 'gitlab.com']);
  });

  it('fails when a git package dependency is not fetchable', async () => {
    const project = makeProject({
      dependencies: { 'com.example.private': 'https://github.com/example/private.git' },
    });
    mocks.spawnProcess.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'fatal: repository not found\n',
      rawStdout: '',
      rawStderr: 'fatal: repository not found\n',
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).not.toBe(0);
    expect(lines.join('')).toContain('https://github.com/example/private.git');
    expect(lines.join('')).toContain('not fetchable');
  });

  it('passes when every git package dependency is fetchable', async () => {
    const project = makeProject({
      dependencies: { 'com.example.private': 'https://github.com/example/private.git' },
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    expect(readReport(project).gitDependencies).toEqual([
      {
        name: 'com.example.private',
        url: 'https://github.com/example/private.git',
        host: 'github.com',
        reachable: true,
        detail: 'git ls-remote succeeded',
      },
    ]);
  });

  it('refuses to run when a git dependency URL embeds credentials', async () => {
    const project = makeProject({
      dependencies: {
        'com.example.private': 'https://user:token@github.com/example/private.git',
      },
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    expect(lines.join('')).toContain('com.example.private');
    expect(lines.join('')).not.toContain('token');
    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it('does not run git ls-remote more than once per unique repository URL', async () => {
    const project = makeProject({
      dependencies: {
        'com.example.one': 'https://github.com/example/mono.git',
        'com.example.two': 'https://github.com/example/mono.git',
        'com.example.three': 'https://github.com/example/other.git',
      },
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    expect(mocks.spawnProcess).toHaveBeenCalledTimes(2);
    expect(readReport(project).gitDependencies).toHaveLength(3);
  });

  it('reports an inactive license under license.mode: none as a blocking failure', async () => {
    scenario.license = { active: false, licenses: [], floatingServer: null };
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    const license = readReport(project).checks.find((check) => check.id === 'license');
    expect(license).toMatchObject({ status: 'fail', blocking: true });
  });

  it('reports but does not fail an inactive license under an activation mode', async () => {
    scenario.license = { active: false, licenses: [], floatingServer: null };
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.license.mode = 'serial';
    });

    const code = await doctorCommand(ctx);

    expect(code).toBe(0);
    const license = readReport(project).checks.find((check) => check.id === 'license');
    expect(license).toMatchObject({ status: 'info', blocking: false });
  });
});
