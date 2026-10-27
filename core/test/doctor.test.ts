import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/commands/doctor.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { diskSpaceCheck, glibcCheck } from '../src/lifecycle/setup.js';
import { createRedactor } from '../src/redact.js';
import { isUnsupportedCommand } from '../src/unity/cli.js';

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
  // A fake host's free space must never decide whether the suite passes (M10).
  config.doctor.minFreeBytes = 1;
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
  checks: { id: string; status: string; code: string; blocking: boolean; message: string }[];
  projectsVerify: { status: string; blocking: boolean; detail: string };
} {
  return JSON.parse(readFileSync(reportPath(project), 'utf8')) as never;
}

function gitOk() {
  return { code: 0, stdout: '', stderr: '', rawStdout: '', rawStderr: '' };
}

function unsupportedResult(command: string) {
  return {
    code: 2,
    stdout: '',
    stderr: `error: unknown command '${command}'`,
    json: {
      success: false,
      errors: [{ code: 'UNKNOWN_COMMAND', message: `unknown command '${command}'` }],
    },
  };
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
    const report = readReport(project);
    for (const id of ['cli-version', 'glibc', 'disk-space', 'projects-verify', 'license']) {
      expect(report.checks.some((check) => check.id === id)).toBe(true);
    }
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
    const capability = readReport(project).checks.find((check) => check.id === 'cli-version');
    expect(capability).toMatchObject({ status: 'info', blocking: false });
    expect(capability?.message).toContain('1.0.0-beta.20');
    expect(capability?.message).toContain('cli-commit-abc');
  });

  it('fails with exit 64 when the CLI is older than the tested floor, and records it', async () => {
    scenario.version = '1.0.0-beta.8';
    const project = makeProject();

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    expect(lines.join('')).toContain('1.0.0-beta.9');
    const capability = readReport(project).checks.find((check) => check.id === 'cli-version');
    expect(capability).toMatchObject({
      status: 'fail',
      code: 'CLI_VERSION_TOO_OLD',
      blocking: true,
    });
    expect(readReport(project).verdict).toBe('fail');
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

  it('does not run the git preflight: setup owns it', async () => {
    const project = makeProject({
      dependencies: { 'com.example.private': 'https://github.com/example/private.git' },
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it('redacts a secret in a check message before writing the report', async () => {
    const secret = 'doctor-secret-token-9f3d';
    const project = makeProject();
    scenario.doctor = {
      verdict: 'pass',
      checks: [
        {
          id: 'machine',
          status: 'pass',
          code: 'OK',
          blocking: true,
          message: `licence echo: ${secret}`,
        },
      ],
    };
    const ctx = makeContext(project);
    ctx.redactor.register(secret);

    const code = await doctorCommand(ctx);

    expect(code).toBe(0);
    const file = readFileSync(reportPath(project), 'utf8');
    expect(file).not.toContain(secret);
    expect(file).toContain('***');
    expect(lines.join('')).not.toContain(secret);
  });

  it('does not treat an unparsable projects verify report as a pass', async () => {
    const project = makeProject();
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      if (options.args[0] === 'projects') {
        return { code: 0, stdout: 'not json', stderr: '', json: null };
      }
      return responder(options.args);
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(0);
    const report = readReport(project);
    expect(report.projectsVerify).toMatchObject({ status: 'info', blocking: false });
    expect(
      report.checks.find((check) => check.id === 'projects-verify'),
    ).toMatchObject({ status: 'info', code: 'PROJECT_VERIFY_NO_REPORT', blocking: false });
  });

  it('returns a clear failure when the report cannot be written', async () => {
    const project = makeProject();
    // A regular file where the output directory must be makes mkdir fail.
    writeFileSync(join(project, 'ci-output'), 'not a directory', 'utf8');

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(6);
    expect(lines.join('')).toContain('could not write the doctor report');
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

  it('reports an unsupported doctor command as a clear named check', async () => {
    const project = makeProject();
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      if (options.args[0] === 'doctor') return unsupportedResult('doctor');
      return responder(options.args);
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    expect(lines.join('')).toContain('does not support `doctor --ci`');
    expect(
      readReport(project).checks.find((check) => check.id === 'unity-doctor'),
    ).toMatchObject({ status: 'fail', code: 'UNSUPPORTED_COMMAND', blocking: true });
  });

  it('reports an unsupported projects verify command as a clear named check', async () => {
    const project = makeProject();
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      if (options.args[0] === 'projects') return unsupportedResult('projects');
      return responder(options.args);
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    expect(lines.join('')).toContain('does not support `projects verify --strict`');
    expect(
      readReport(project).checks.find((check) => check.id === 'projects-verify'),
    ).toMatchObject({ code: 'UNSUPPORTED_COMMAND', blocking: true });
  });

  it('reports an unsupported license status command as a clear named check', async () => {
    const project = makeProject();
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      if (options.args[0] === 'license') return unsupportedResult('license');
      return responder(options.args);
    });

    const code = await doctorCommand(makeContext(project));

    expect(code).toBe(64);
    expect(lines.join('')).toContain('does not support `license status`');
    expect(
      readReport(project).checks.find((check) => check.id === 'license'),
    ).toMatchObject({ status: 'fail', code: 'UNSUPPORTED_COMMAND', blocking: true });
  });
});

describe('core environment checks', () => {
  it('reports glibc as info on Windows and macOS, and fails on Linux below 2.34', () => {
    expect(glibcCheck('win32')).toMatchObject({ status: 'info', blocking: false });
    expect(glibcCheck('darwin')).toMatchObject({ status: 'info', blocking: false });

    const tooOld = glibcCheck('linux', '2.31');
    expect(tooOld).toMatchObject({ status: 'fail', blocking: true, code: 'GLIBC_TOO_OLD' });
    expect(tooOld.message).toContain('2.34');

    // Numeric, not string ordering: 2.9 is older than 2.34.
    expect(glibcCheck('linux', '2.9')).toMatchObject({ status: 'fail', blocking: true });
    expect(glibcCheck('linux', '2.34')).toMatchObject({ status: 'pass', blocking: false });
    expect(glibcCheck('linux', '3.0')).toMatchObject({ status: 'pass', blocking: false });
    expect(glibcCheck('linux', null)).toMatchObject({ status: 'info', blocking: false });
  });

  it('reports disk space as info when free space cannot be determined', () => {
    const ctx = makeContext(makeProject());
    const check = diskSpaceCheck(ctx, () => {
      throw new Error('statfs unavailable');
    });

    expect(check).toMatchObject({ id: 'disk-space', status: 'info', blocking: false });
    expect(check.message).toContain('statfs unavailable');
    expect(check.message).toContain('was not checked');
  });

  it('fails disk space below the configured floor and passes at or above it', () => {
    const ctx = makeContext(makeProject(), (config) => {
      config.doctor.minFreeBytes = 1024;
    });

    const low = diskSpaceCheck(ctx, () => ({ bsize: 1024, bavail: 0 }));
    expect(low).toMatchObject({ status: 'fail', blocking: true, code: 'DISK_SPACE_LOW' });
    expect(low.message).toContain('below the configured floor');

    const ok = diskSpaceCheck(ctx, () => ({ bsize: 1024, bavail: 2 }));
    expect(ok).toMatchObject({ status: 'pass', blocking: false });
    expect(ok.message).toContain('floor');
  });

  it('recognises only a missing command, never a genuine failure', () => {
    expect(
      isUnsupportedCommand({
        code: 2,
        stdout: '',
        stderr: '',
        json: {
          success: false,
          errors: [{ code: 'UNKNOWN_COMMAND', message: "unknown command 'doctor'" }],
        },
      }),
    ).toBe(true);

    expect(
      isUnsupportedCommand({
        code: 2,
        stdout: '',
        stderr: "error: unknown command 'projects'",
        json: null,
      }),
    ).toBe(true);

    expect(
      isUnsupportedCommand({
        code: 6,
        stdout: '',
        stderr: 'error: compilation failed',
        json: {
          success: false,
          errors: [{ code: 'COMPILE_ERROR', message: 'compilation failed' }],
        },
      }),
    ).toBe(false);

    expect(
      isUnsupportedCommand({
        code: 2,
        stdout: '',
        stderr: 'error: unknown option --format',
        json: null,
      }),
    ).toBe(false);

    expect(
      isUnsupportedCommand({
        code: 2,
        stdout: '',
        stderr: 'error: unknown command line argument --format',
        json: null,
      }),
    ).toBe(false);

    expect(
      isUnsupportedCommand({ code: 0, stdout: '', stderr: '', json: null }),
    ).toBe(false);
  });
});
