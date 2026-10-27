import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupCommand } from '../src/commands/setup.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { describeGitFailures } from '../src/lifecycle/setup.js';
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
  editors?: unknown[];
  modules?: unknown[];
  doctor?: unknown;
  doctorCode?: number;
  doctorSuccess?: boolean;
  verify?: unknown;
  verifyCode?: number;
  license?: unknown;
  licenseCode?: number;
  termsCode?: number;
  installCode?: number;
}

const calls: string[][] = [];
const lines: string[] = [];
const tempDirs: string[] = [];
let scenario: Scenario = {};

const EDITOR = '6000.0.47f1';

function envelope(data: unknown, code = 0, success = true) {
  return { code, stdout: '', stderr: '', json: { success, data } };
}

function failure(code: number, stderr: string, data?: unknown) {
  return { code, stdout: '', stderr, json: data === undefined ? null : { success: false, data } };
}

function editorRow(version: string, modules = ''): unknown {
  return {
    version,
    alias: version,
    architecture: 'x86_64',
    location: `C:/Unity/${version}/Editor/Unity.exe`,
    modules,
    default: false,
  };
}

function moduleRow(id: string, isInstalled: boolean): unknown {
  return { id, name: id, status: isInstalled ? 'installed' : 'available', aliases: [], isInstalled };
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

function defaultDoctor(): unknown {
  return {
    verdict: 'pass',
    checks: [
      { id: 'machine', status: 'pass', code: 'OK', blocking: true, message: 'machine ready' },
    ],
  };
}

function defaultLicense(): unknown {
  return {
    active: true,
    signedIn: true,
    licenses: [{ product: 'Unity Personal', type: 'Assigned' }],
    floatingServer: null,
  };
}

function responder(args: string[]) {
  if (args[0] === 'version') {
    return envelope({
      version: scenario.version ?? '1.0.0-beta.14',
      channel: 'beta',
      commit: 'cli-commit-abc',
    });
  }
  if (args[0] === 'editors') {
    return envelope(scenario.editors ?? [editorRow(EDITOR)]);
  }
  if (args[0] === 'install' && args.includes('--list-modules')) {
    return envelope(
      scenario.modules ?? [moduleRow('android', true), moduleRow('webgl', true)],
    );
  }
  if (args[0] === 'install') {
    const code = scenario.installCode ?? 0;
    return code === 0 ? envelope({ installed: true }) : failure(code, 'install failed');
  }
  if (args[0] === 'terms') {
    const code = scenario.termsCode ?? 0;
    return code === 0 ? envelope({ accepted: true }) : failure(code, 'terms failed');
  }
  if (args[0] === 'doctor') {
    return envelope(
      scenario.doctor ?? defaultDoctor(),
      scenario.doctorCode ?? 0,
      scenario.doctorSuccess ?? true,
    );
  }
  if (args[0] === 'projects') {
    return envelope(
      scenario.verify ?? { errors: [] },
      scenario.verifyCode ?? 0,
    );
  }
  if (args[0] === 'license') {
    const code = scenario.licenseCode ?? 0;
    return code === 0
      ? envelope(scenario.license ?? defaultLicense())
      : failure(code, 'license command failed', scenario.license ?? { active: false });
  }
  return envelope({});
}

function makeProject(withProjectVersion = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-setup-'));
  tempDirs.push(dir);
  if (withProjectVersion) {
    mkdirSync(join(dir, 'ProjectSettings'), { recursive: true });
    writeFileSync(
      join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 6000.0.47f1\nm_EditorVersionWithRevision: 6000.0.47f1 (abc123)\n',
      'utf8',
    );
  }
  return dir;
}

function makeContext(projectPath: string, edit?: (config: Config) => void): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  // Never let the host's free space decide whether the suite passes (M10).
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

function installCalls(): string[][] {
  return calls.filter((args) => args[0] === 'install' && !args.includes('--list-modules'));
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
  mocks.spawnProcess.mockResolvedValue({
    code: 0,
    stdout: '',
    stderr: '',
    rawStdout: '',
    rawStderr: '',
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('setupCommand', () => {
  it('installs the editor when it is not installed', async () => {
    scenario.editors = [];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = true;
      config.unity.editor.modules = ['android'];
      config.unity.editor.childModules = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(installCalls().map((args) => args.slice(0, 2))).toContainEqual([
      'install',
      EDITOR,
    ]);
  });

  it('accepts the Editor Software Terms after installing', async () => {
    scenario.editors = [];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = true;
      config.unity.editor.childModules = false;
      config.unity.editor.terms = true;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    const installIndex = calls.findIndex(
      (args) => args[0] === 'install' && !args.includes('--list-modules'),
    );
    const termsIndex = calls.findIndex(
      (args) => args[0] === 'terms' && args[1] === 'accept' && args[2] === EDITOR,
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(termsIndex).toBeGreaterThan(installIndex);
  });

  it('does not reinstall an editor that is already installed', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(installCalls()).toEqual([]);
  });

  it('passes the module list and --cm to unity install', async () => {
    scenario.editors = [];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = true;
      config.unity.editor.modules = ['android', 'webgl'];
      config.unity.editor.childModules = true;
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    const install = installCalls()[0];
    expect(install).toBeDefined();
    expect(install).toContain('--module');
    expect(install).toContain('android');
    expect(install).toContain('webgl');
    expect(install).toContain('--cm');
    expect(install).toContain('--accept-eula');
  });

  it('fails with exit 64 when the editor version is not from-project and is not a valid version', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.version = 'not a version!';
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('not a valid Editor version');
    expect(installCalls()).toEqual([]);
  });

  it('rejects an option-like Editor version read from ProjectVersion.txt', async () => {
    const project = makeProject(false);
    mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
    writeFileSync(
      join(project, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: --help\n',
      'utf8',
    );
    const ctx = makeContext(project, (config) => {
      config.unity.editor.version = 'from-project';
      config.unity.editor.terms = true;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    const output = lines.join('');
    expect(output).toContain('ProjectVersion.txt');
    expect(output).toContain('"--help"');
    expect(output).toContain('not a valid Editor version');
    // The terms command is never reached.
    expect(calls.some((args) => args[0] === 'terms')).toBe(false);
  });

  it('does not run unity doctor: doctor is a separate preflight', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(calls.some((args) => args[0] === 'doctor')).toBe(false);
  });

  it('does not pass --accept-eula unless the config opts in', async () => {
    scenario.editors = [];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
      config.unity.editor.modules = [];
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(installCalls()).toEqual([]);
    expect(lines.join('')).toContain(`unity install ${EDITOR} --yes --accept-eula`);
  });

  it('passes --accept-eula when the config opts in', async () => {
    scenario.editors = [];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = true;
      config.unity.editor.childModules = false;
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    const install = installCalls()[0];
    expect(install).toContain('--accept-eula');
    expect(install).not.toContain('--allow-install');
  });

  it('keeps --cm out of the argv and the printed command when no module is selected', async () => {
    scenario.editors = [];
    const project = makeProject();
    const installCtx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = true;
      config.unity.editor.childModules = true;
      config.unity.editor.modules = [];
      config.unity.editor.terms = false;
    });

    expect(await setupCommand(installCtx)).toBe(0);
    const install = installCalls()[0]!;
    expect(install).not.toContain('--cm');
    expect(install).not.toContain('--no-cm');

    scenario.editors = [];
    lines.length = 0;
    const messageCtx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = true;
      config.unity.editor.modules = [];
    });

    expect(await setupCommand(messageCtx)).toBe(64);
    expect(lines.join('')).toContain(`unity install ${EDITOR} --yes --accept-eula`);
    expect(lines.join('')).not.toContain('--cm');
  });

  it('fails when the installed editor is missing the module the build target needs', async () => {
    scenario.editors = [editorRow(EDITOR, '')];
    scenario.modules = [
      moduleRow('android', false),
      moduleRow('webgl', true),
    ];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, ['android']);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('android');
    expect(lines.join('')).toContain(`unity install ${EDITOR} --module android --no-cm --yes --accept-eula`);
    expect(installCalls()).toEqual([]);
    // The display-name `modules` string is never used: the authoritative check
    // is `--list-modules` + `isInstalled`.
    expect(calls.some((args) => args.includes('--list-modules'))).toBe(true);
  });

  it('installs nothing when the Editor and every required module are present', async () => {
    scenario.editors = [editorRow(EDITOR, '')];
    scenario.modules = [
      moduleRow('android', true),
      moduleRow('android-sdk-ndk-tools', true),
    ];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'Android';
      config.unity.editor.acceptEula = true;
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, { command: 'build' });

    expect(code).toBe(0);
    expect(installCalls()).toEqual([]);
    expect(calls.filter((args) => args.includes('--list-modules'))).toHaveLength(1);
  });

  it('installs only the missing module and re-checks when the EULA is accepted', async () => {
    let listCalls = 0;
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      calls.push(options.args);
      if (options.args[0] === 'install' && options.args.includes('--list-modules')) {
        listCalls += 1;
        return envelope(
          listCalls === 1
            ? [moduleRow('android', false), moduleRow('android-sdk-ndk-tools', true)]
            : [moduleRow('android', true), moduleRow('android-sdk-ndk-tools', true)],
        );
      }
      return responder(options.args);
    });
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'Android';
      config.unity.editor.acceptEula = true;
      config.unity.editor.childModules = false;
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, { command: 'build' });

    expect(code).toBe(0);
    const installs = installCalls();
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain('--module');
    expect(installs[0]).toContain('android');
    expect(installs[0]).not.toContain('android-sdk-ndk-tools');
    expect(calls.filter((args) => args.includes('--list-modules'))).toHaveLength(2);
  });

  it('fails fast with the exact install command when the editor is missing', async () => {
    scenario.editors = [];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
      config.unity.editor.modules = [];
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    const output = lines.join('');
    expect(output).toContain(`unity install ${EDITOR} --yes --accept-eula`);
    expect(output).not.toContain('--allow-install');
    expect(installCalls()).toEqual([]);
  });

  it('fails when unity license status reports no active license', async () => {
    scenario.license = { active: false, licenses: [], floatingServer: null };
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
      config.license.mode = 'none';
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('unity license activate');
  });

  it('resolves the editor version from ProjectSettings/ProjectVersion.txt', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.version = 'from-project';
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(calls.some((args) => args[0] === 'editors')).toBe(true);
    expect(lines.join('')).toContain(EDITOR);
  });

  it('fails with exit 64 naming the missing ProjectVersion.txt', async () => {
    const project = makeProject(false);
    const ctx = makeContext(project, (config) => {
      config.unity.editor.version = 'from-project';
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('ProjectVersion.txt');
  });

  it('does not check modules when the invoked command requires none', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.modules = ['android'];
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(calls.some((args) => args.includes('--list-modules'))).toBe(false);
  });

  it('asks unity for the authoritative module list, not the editors display names', async () => {
    scenario.editors = [editorRow(EDITOR, 'Android, Android SDK & NDK Tools')];
    scenario.modules = [moduleRow('android', true)];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, ['android']);

    expect(code).toBe(0);
    expect(calls).toContainEqual([
      'install',
      EDITOR,
      '--list-modules',
      '--format',
      'json',
    ]);
  });

  it('reports an inactive license under an activation mode without failing', async () => {
    scenario.license = { active: false, licenses: [], floatingServer: null };
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
      config.license.mode = 'serial';
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(lines.join('')).toContain('license.mode "serial"');
  });

  it('refuses a git dependency URL that embeds credentials', async () => {
    const project = makeProject();
    mkdirSync(join(project, 'Packages'), { recursive: true });
    writeFileSync(
      join(project, 'Packages', 'manifest.json'),
      JSON.stringify({
        dependencies: {
          'com.example.private': 'https://user:token@github.com/example/private.git',
        },
      }),
      'utf8',
    );
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
      config.packages.preflight = true;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('com.example.private');
    expect(lines.join('')).not.toContain('token');
    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it('preflights git package dependencies and fails when one is not fetchable', async () => {
    const project = makeProject();
    mkdirSync(join(project, 'Packages'), { recursive: true });
    writeFileSync(
      join(project, 'Packages', 'manifest.json'),
      JSON.stringify({
        dependencies: {
          'com.example.private': 'https://github.com/example/private.git',
        },
      }),
      'utf8',
    );
    mocks.spawnProcess.mockResolvedValue({
      code: 128,
      stdout: '',
      stderr: 'fatal: repository not found\n',
      rawStdout: '',
      rawStderr: 'fatal: repository not found\n',
    });
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
      config.packages.preflight = true;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(mocks.spawnProcess).toHaveBeenCalledTimes(1);
    expect(lines.join('')).toContain('https://github.com/example/private.git');
    expect(lines.join('')).toContain('not fetchable');
  });

  it('passes git dependencies and probes each unique repository once', async () => {
    const project = makeProject();
    mkdirSync(join(project, 'Packages'), { recursive: true });
    writeFileSync(
      join(project, 'Packages', 'manifest.json'),
      JSON.stringify({
        dependencies: {
          'com.example.one': 'https://github.com/example/mono.git',
          'com.example.two': 'https://github.com/example/mono.git',
          'com.example.three': 'https://github.com/example/other.git',
        },
      }),
      'utf8',
    );
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
      config.packages.preflight = true;
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(0);
    expect(mocks.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('redacts a credential-bearing URL in a git failure message', () => {
    const redactor = createRedactor();
    redactor.register('token-9f3d');
    const message = describeGitFailures(
      [
        {
          dependency: {
            name: 'com.example.private',
            url: 'https://user:token-9f3d@github.com/example/private.git',
            host: 'github.com',
            hasEmbeddedCredentials: true,
          },
          reachable: false,
          detail: 'not contacted',
        },
      ],
      redactor,
    );

    expect(message).not.toContain('token-9f3d');
    expect(message).toContain('***');
  });

  it('derives the required modules from config.build.target for a build', async () => {
    scenario.modules = [
      moduleRow('android', true),
      moduleRow('android-sdk-ndk-tools', false),
    ];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'Android';
      config.unity.editor.terms = false;
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
    });

    const code = await setupCommand(ctx, { command: 'build' });

    expect(code).toBe(64);
    expect(calls).toContainEqual([
      'install',
      EDITOR,
      '--list-modules',
      '--format',
      'json',
    ]);
    expect(lines.join('')).toContain('android-sdk-ndk-tools');
  });

  it('checks only the Editor version for a build target that needs no module', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'StandaloneWindows64';
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, { command: 'build', host: 'windows' });

    expect(code).toBe(0);
    expect(calls.some((args) => args.includes('--list-modules'))).toBe(false);
  });

  it('requires windows-il2cpp when a Windows player is built on Linux', async () => {
    scenario.modules = [moduleRow('windows-il2cpp', false)];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'StandaloneWindows64';
      config.unity.editor.terms = false;
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
    });

    const code = await setupCommand(ctx, { command: 'build', host: 'linux' });

    expect(code).toBe(64);
    expect(lines.join('')).toContain('windows-il2cpp');
    expect(calls).toContainEqual([
      'install',
      EDITOR,
      '--list-modules',
      '--format',
      'json',
    ]);
  });

  it('fails in seconds for a macOS-only target on a non-macOS host', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'StandaloneOSX';
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, { command: 'build', host: 'linux' });

    expect(code).toBe(64);
    expect(lines.join('')).toContain('requires a macOS host');
    expect(calls.some((args) => args[0] === 'editors')).toBe(false);
  });

  it('treats an empty requiredModules array as no override', async () => {
    scenario.modules = [moduleRow('android', false)];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'Android';
      config.unity.editor.terms = false;
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
    });

    const code = await setupCommand(ctx, {
      command: 'build',
      requiredModules: [],
      host: 'windows',
    });

    expect(code).toBe(64);
    expect(lines.join('')).toContain('android');
    expect(calls.some((args) => args.includes('--list-modules'))).toBe(true);
  });

  it('checks no platform module for a test run', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.test.modes = ['EditMode', 'PlayMode'];
      config.unity.editor.terms = false;
    });

    const code = await setupCommand(ctx, { command: 'test' });

    expect(code).toBe(0);
    expect(calls.some((args) => args.includes('--list-modules'))).toBe(false);
  });

  it('lets an explicit requiredModules override win over the config derivation', async () => {
    scenario.modules = [moduleRow('webgl', false)];
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.build.target = 'StandaloneWindows64';
      config.unity.editor.terms = false;
      config.unity.editor.acceptEula = false;
      config.unity.editor.childModules = false;
    });

    const code = await setupCommand(ctx, {
      command: 'build',
      requiredModules: ['webgl'],
    });

    expect(code).toBe(64);
    expect(lines.join('')).toContain('webgl');
    expect(calls.some((args) => args.includes('--list-modules'))).toBe(true);
  });

  it('reports an unsupported editors command instead of a generic failure', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
    });
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      if (options.args[0] === 'editors') return unsupportedResult('editors');
      return responder(options.args);
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('does not support `editors --installed`');
  });

  it('reports an unsupported license status command instead of a generic failure', async () => {
    const project = makeProject();
    const ctx = makeContext(project, (config) => {
      config.unity.editor.terms = false;
    });
    mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
      if (options.args[0] === 'license') return unsupportedResult('license');
      return responder(options.args);
    });

    const code = await setupCommand(ctx);

    expect(code).toBe(64);
    expect(lines.join('')).toContain('does not support `license status`');
  });
});
