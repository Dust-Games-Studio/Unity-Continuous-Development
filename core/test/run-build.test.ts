import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCommand } from '../src/commands/run.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { runBuild } from '../src/lifecycle/build.js';
import { LicenseError } from '../src/lifecycle/license.js';
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
// exercised by the build path itself.
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

interface TargetRow {
  target: string;
  zeroCode: boolean;
  requirement: string;
}

const ZERO_CODE = 'Zero-code (no --execute-method needed, but --output-path is still required)';
const NEEDS_CODE = 'Requires --execute-method, or a Unity 6+ build profile (--profile)';

const DEFAULT_TARGETS: TargetRow[] = [
  { target: 'StandaloneWindows64', zeroCode: true, requirement: ZERO_CODE },
  { target: 'StandaloneLinux64', zeroCode: true, requirement: ZERO_CODE },
  { target: 'StandaloneOSX', zeroCode: true, requirement: ZERO_CODE },
  { target: 'Android', zeroCode: false, requirement: NEEDS_CODE },
  { target: 'WebGL', zeroCode: false, requirement: NEEDS_CODE },
];

interface BuildOutcome {
  code: number;
  /** What the fake Editor leaves at `--output-path`. */
  artifact?: 'dir' | 'file' | 'none';
  /** A JSON manifest to write, a raw string (malformed), or null for none. */
  provenance?: Record<string, unknown> | string | null;
  /** False leaves no Editor log behind. */
  log?: boolean;
  /** Backdates the artifact tree, as if an earlier attempt wrote it. */
  staleMtime?: boolean;
}

interface TestOutcome {
  code: number;
  /** The NUnit report to write, or null for none. */
  nunit?: string | null;
  /** The JUnit report to write, or null for none. An empty string is "empty". */
  junit?: string | null;
}

interface ResponderCall {
  args: string[];
  outputPath: string;
  provenancePath: string;
  logFile: string;
}

const tempDirs: string[] = [];
const lines: string[] = [];
const order: string[] = [];
/** The final `unity build` argv the child receives (not the --list-targets call). */
const buildCalls: string[][] = [];
/** Every `unity build --list-targets` argv the child receives. */
const listCalls: string[][] = [];
/** Every `unity license return` argv the child receives. */
const licenseReturns: string[][] = [];
/** The final `unity test` argv the child receives, for the JUnit fallback. */
const testCalls: string[][] = [];

let targets: TargetRow[];
let buildResponder: (call: ResponderCall) => BuildOutcome;
let testResponder: () => TestOutcome;

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-run-build-'));
  tempDirs.push(dir);
  return dir;
}

function makeContext(root: string, edit?: (config: Config) => void): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  // Tests must not wait out the production backoff.
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

function provenancePath(root: string): string {
  return join(root, 'ci-output', 'build', 'provenance.json');
}

function renderProvenance(value: Record<string, unknown> | string): string {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

/** Backdates every file and directory in a tree, simulating an older attempt. */
function ageTree(path: string, when: Date): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) ageTree(child, when);
    else utimesSync(child, when, when);
  }
  utimesSync(path, when, when);
}

beforeEach(() => {
  lines.length = 0;
  order.length = 0;
  buildCalls.length = 0;
  listCalls.length = 0;
  licenseReturns.length = 0;
  testCalls.length = 0;
  targets = DEFAULT_TARGETS;
  testResponder = () => ({ code: 0, nunit: null, junit: null });
  buildResponder = () => ({
    code: 0,
    artifact: 'dir',
    provenance: {
      cliVersion: '1.0.0-beta.14',
      editorVersion: '6000.6.3f1',
      target: 'StandaloneWindows64',
    },
  });
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

      if (args[0] === 'test') {
        order.push('unity-test');
        testCalls.push(args);
        const output = valueAfter(args, '--output');
        const junit = valueAfter(args, '--junit-output');
        const outcome = testResponder();
        if (outcome.nunit !== null && outcome.nunit !== undefined) {
          mkdirSync(dirname(output), { recursive: true });
          writeFileSync(output, outcome.nunit);
        }
        if (outcome.junit !== null && outcome.junit !== undefined) {
          mkdirSync(dirname(junit), { recursive: true });
          writeFileSync(junit, outcome.junit);
        }
        return {
          code: outcome.code,
          stdout: '',
          stderr: '',
          json: { success: outcome.code === 0, data: {} },
        };
      }

      if (args.includes('--list-targets')) {
        listCalls.push(args);
        return {
          code: 0,
          stdout: '',
          stderr: '',
          json: { success: true, data: targets },
        };
      }

      order.push('unity-build');
      buildCalls.push(args);
      const outputPath = valueAfter(args, '--output-path');
      const manifest = valueAfter(args, '--provenance-path');
      const logFile = valueAfter(args, '--log-file');
      const outcome = buildResponder({ args, outputPath, provenancePath: manifest, logFile });

      if (outcome.artifact === 'dir') {
        mkdirSync(outputPath, { recursive: true });
        writeFileSync(join(outputPath, 'game.exe'), 'MZ');
      } else if (outcome.artifact === 'file') {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, 'MZ');
      }
      if (outcome.staleMtime === true && existsSync(outputPath)) {
        ageTree(outputPath, new Date(Date.now() - 60_000));
      }
      if (outcome.provenance !== null && outcome.provenance !== undefined) {
        mkdirSync(dirname(manifest), { recursive: true });
        writeFileSync(manifest, renderProvenance(outcome.provenance));
      }
      if (outcome.log !== false) {
        mkdirSync(dirname(logFile), { recursive: true });
        writeFileSync(logFile, 'Unity Editor log\n');
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

describe('run build', () => {
  it('runs doctor, then setup, activates, builds and returns the license', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const result = await runBuild(ctx);

    // The binding order (Section 4.5), exactly as `run test` orders it.
    expect(order).toEqual(['doctor', 'setup', 'activate', 'unity-build', 'license-return']);
    expect(result).toMatchObject({
      status: 'passed',
      exitCode: 0,
      unityExitCode: 0,
      attempts: 1,
      artifacts: ['build/game'],
      provenance: {
        cliVersion: '1.0.0-beta.14',
        editorVersion: '6000.6.3f1',
        target: 'StandaloneWindows64',
      },
    });
    expect(ctx.licenseActivated).toBe(true);
    expect(readSummary(root).license).toMatchObject({
      mode: 'serial',
      activated: true,
      returned: true,
    });
  });

  it('passes --target and --output-path to unity build', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.target = 'StandaloneLinux64';
      config.build.outputPath = 'ci-output/build/linux';
    });

    expect(await runCommand(ctx, 'build')).toBe(0);

    const args = buildCalls[0]!;
    expect(valueAfter(args, '--target')).toBe('StandaloneLinux64');
    expect(valueAfter(args, '--output-path')).toBe(join(root, 'ci-output', 'build', 'linux'));
    // The complete argv, including the wrapper's placement of `--format json`.
    expect(args).toEqual([
      'build',
      root,
      '--target',
      'StandaloneLinux64',
      '--output-path',
      join(root, 'ci-output', 'build', 'linux'),
      '--log-file',
      join(root, 'ci-output', 'logs', 'editor.log'),
      '--provenance-path',
      join(root, 'ci-output', 'build', 'provenance.json'),
      // The streamed Editor log would be interleaved into stdout, and
      // `--format json` does not disable it; the log still lands in --log-file.
      '--no-tail',
      // R14: a batch build never renders, and there is no `--` on this verb.
      '--args',
      '-nographics',
      '--format',
      'json',
    ]);
  });

  it('passes --log-file so the Editor log lands in ci-output/logs/editor.log', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'build')).toBe(0);

    expect(valueAfter(buildCalls[0]!, '--log-file')).toBe(
      join(root, 'ci-output', 'logs', 'editor.log'),
    );
    // GC10: `unity build` takes --log-file; the summary publishes the log it
    // verifiably wrote, relative to output.dir.
    expect(readSummary(root).logs).toEqual({ editor: 'logs/editor.log', cli: null });
  });

  it('passes --execute-method only when configured', async () => {
    const withoutRoot = makeProject();
    expect(await runCommand(makeContext(withoutRoot), 'build')).toBe(0);
    expect(buildCalls[0]).not.toContain('--execute-method');

    const withRoot = makeProject();
    const ctx = makeContext(withRoot, (config) => {
      config.build.executeMethod = 'Build.Editor.BuildPlayer';
    });
    expect(await runCommand(ctx, 'build')).toBe(0);
    expect(valueAfter(buildCalls[1]!, '--execute-method')).toBe('Build.Editor.BuildPlayer');
  });

  it('passes --versioning-strategy custom with --build-version', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.versioningStrategy = 'custom';
      config.build.buildVersion = '1.2.3';
    });

    expect(await runCommand(ctx, 'build')).toBe(0);

    const args = buildCalls[0]!;
    expect(valueAfter(args, '--versioning-strategy')).toBe('custom');
    expect(valueAfter(args, '--build-version')).toBe('1.2.3');
  });

  it('does not pass --build-version unless the strategy is custom', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.versioningStrategy = 'semantic';
      config.build.buildVersion = '1.2.3';
    });

    expect(await runCommand(ctx, 'build')).toBe(0);

    const args = buildCalls[0]!;
    expect(valueAfter(args, '--versioning-strategy')).toBe('semantic');
    expect(args).not.toContain('--build-version');
  });

  it('passes --android-export-type and --android-version-code when configured', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.target = 'Android';
      config.build.executeMethod = 'Build.Editor.BuildPlayer';
      config.build.androidExportType = 'aab';
      config.build.androidVersionCode = 42;
      config.build.androidTargetSdkVersion = 34;
    });

    expect(await runCommand(ctx, 'build')).toBe(0);

    const args = buildCalls[0]!;
    expect(valueAfter(args, '--android-export-type')).toBe('aab');
    expect(valueAfter(args, '--android-version-code')).toBe('42');
    expect(valueAfter(args, '--android-target-sdk-version')).toBe('34');
  });

  it('passes --allow-dirty-build only when configured', async () => {
    const cleanRoot = makeProject();
    expect(await runCommand(makeContext(cleanRoot), 'build')).toBe(0);
    expect(buildCalls[0]).not.toContain('--allow-dirty-build');

    const dirtyRoot = makeProject();
    const ctx = makeContext(dirtyRoot, (config) => {
      config.build.allowDirtyBuild = true;
    });
    expect(await runCommand(ctx, 'build')).toBe(0);
    expect(buildCalls[1]).toContain('--allow-dirty-build');
  });

  it('fails with exit 64 when the target needs an execute-method and none is configured', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.target = 'Android';
    });

    const code = await runCommand(ctx, 'build');

    expect(code).toBe(64);
    // The machine-readable list is consulted once, before the build; the build
    // itself never starts.
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual([
      'build',
      root,
      '--list-targets',
      '--format',
      'json',
    ]);
    expect(buildCalls).toHaveLength(0);
    // Both ways out are named, not just the missing flag.
    expect(textOutput()).toContain('--execute-method');
    expect(textOutput()).toContain('--profile');
    const summary = readSummary(root);
    expect(summary.status).toBe('config_error');
    expect(summary.exitCode).toBe(64);
  });

  it('accepts a build profile path as the alternative to --execute-method', async () => {
    const profile = 'Assets/Settings/Build Profiles/Windows Release.asset';
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.profile = profile;
    });

    expect(await runCommand(ctx, 'build')).toBe(0);

    const args = buildCalls[0]!;
    expect(valueAfter(args, '--profile')).toBe(profile);
    // The profile defines the target, so `--target` is not sent at all, and
    // there is no target to validate against --list-targets.
    expect(args).not.toContain('--target');
    expect(listCalls).toHaveLength(0);
  });

  it('fails with exit 64 when neither a target nor a profile is configured', async () => {
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.build.target = '';
    });

    const code = await runCommand(ctx, 'build');

    expect(code).toBe(64);
    // A configuration error is caught before anything is spawned.
    expect(mocks.doctorCommand).not.toHaveBeenCalled();
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.activateLicense).not.toHaveBeenCalled();
    expect(listCalls).toHaveLength(0);
    expect(buildCalls).toHaveLength(0);
    expect(textOutput()).toContain('--target');
    expect(textOutput()).toContain('--profile');
  });

  it('never passes --allow-install', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'build')).toBe(0);

    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0]).not.toContain('--allow-install');
    expect(listCalls[0]).not.toContain('--allow-install');
  });

  it('writes the provenance manifest and merges it into summary.json', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'build')).toBe(0);

    expect(existsSync(provenancePath(root))).toBe(true);
    const summary = readSummary(root);
    expect(summary).toHaveProperty('provenance');
    expect(summary.provenance).toEqual({
      cliVersion: '1.0.0-beta.14',
      editorVersion: '6000.6.3f1',
      target: 'StandaloneWindows64',
    });
  });

  it('leaves provenance null and warns when Unity wrote none', async () => {
    buildResponder = () => ({ code: 0, artifact: 'dir', provenance: null });
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'build')).toBe(0);

    expect(readSummary(root).provenance).toBeNull();
    expect(textOutput()).toContain('no provenance manifest');
  });

  it('lists the build output under artifacts in summary.json', async () => {
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'build')).toBe(0);

    const summary = readSummary(root);
    expect(summary.artifacts).toEqual(['build/game']);
    expect((summary.artifacts as string[]).length).toBeGreaterThan(0);
  });

  it('returns the license when the build fails', async () => {
    buildResponder = () => ({ code: 11, artifact: 'none', provenance: null });
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'build');

    expect(code).toBe(11);
    expect(licenseReturns).toHaveLength(1);
    expect(licenseReturns[0]).toEqual(['license', 'return', '--yes', '--format', 'json']);
    expect(readSummary(root).license).toMatchObject({ activated: true, returned: true });
  });

  it('does not return a license it never took', async () => {
    mocks.activateLicense.mockImplementation(async () => {
      order.push('activate');
      throw new LicenseError('no serial in the environment', 64);
    });
    const root = makeProject();
    const ctx = makeContext(root, (config) => {
      config.license.mode = 'serial';
    });

    const code = await runCommand(ctx, 'build');

    expect(code).toBe(64);
    expect(order).toEqual(['doctor', 'setup', 'activate']);
    expect(buildCalls).toHaveLength(0);
    // The `finally` runs the teardown, but the seat gate inside `returnLicense`
    // refuses to return a licence this process never took.
    expect(licenseReturns).toHaveLength(0);
    expect(textOutput()).toContain('activated no license seat');
  });

  it('returns the recorded exit code on a failed build', async () => {
    // A raw Unity infrastructure code is passed through verbatim.
    const unityRoot = makeProject();
    buildResponder = () => ({ code: 11, artifact: 'none', provenance: null });
    expect(await runCommand(makeContext(unityRoot), 'build')).toBe(11);
    expect(readSummary(unityRoot)).toMatchObject({
      status: 'infra_failed',
      exitCode: 11,
      unityExitCode: 11,
    });

    // Unity exited 0 but produced nothing: the build-side false green is 6.
    const emptyRoot = makeProject();
    buildResponder = () => ({ code: 0, artifact: 'none', provenance: null });
    expect(await runCommand(makeContext(emptyRoot), 'build')).toBe(6);
    expect(readSummary(emptyRoot)).toMatchObject({
      status: 'infra_failed',
      exitCode: 6,
      unityExitCode: 0,
    });

    // Unity exited 0 and produced the player, but the published manifest is
    // malformed: a produced artifact we cannot read is 65 (GC7).
    const malformedRoot = makeProject();
    buildResponder = () => ({ code: 0, artifact: 'dir', provenance: '{"broken"' });
    expect(await runCommand(makeContext(malformedRoot), 'build')).toBe(65);
    expect(readSummary(malformedRoot)).toMatchObject({
      status: 'infra_failed',
      exitCode: 65,
      unityExitCode: 0,
    });
  });

  it('does not accept the previous attempt’s artifact after a retry', async () => {
    let attempt = 0;
    buildResponder = () => {
      attempt += 1;
      // The first attempt writes a player and then fails the invocation; the
      // retry exits 0 without touching anything. The stale tree must not count.
      return attempt === 1
        ? {
            code: 7,
            artifact: 'dir',
            provenance: { target: 'StandaloneWindows64' },
            staleMtime: true,
          }
        : { code: 0, artifact: 'none', provenance: null };
    };
    const root = makeProject();
    const ctx = makeContext(root);

    const code = await runCommand(ctx, 'build');

    expect(code).toBe(6);
    expect(buildCalls).toHaveLength(2);
    const summary = readSummary(root);
    expect(summary.status).toBe('infra_failed');
    expect(summary.exitCode).toBe(6);
    expect(summary.unityExitCode).toBe(0);
    expect(summary.attempts).toBe(2);
  });

  it('converts NUnit to JUnit when unity produced no JUnit file', async () => {
    const secret = 'SUPER-SECRET-TOKEN';
    const nunit = readFileSync(new URL('./fixtures/editmode-fail.xml', import.meta.url), 'utf8')
      .replace('Expected 2 but was 3', `Expected ${secret} but was 3`);
    testResponder = () => ({ code: 8, nunit, junit: null });
    const root = makeProject();
    const ctx = makeContext(root);
    ctx.redactor.register(secret);

    expect(await runCommand(ctx, 'test')).toBe(8);

    const junitPath = join(root, 'ci-output', 'tests', 'EditMode.junit.xml');
    expect(existsSync(junitPath)).toBe(true);
    const converted = readFileSync(junitPath, 'utf8');
    expect(converted).toContain('<testsuites');
    // The fallback file is a CI artifact; it goes through the redactor before
    // the bytes reach disk.
    expect(converted).not.toContain(secret);
    expect(converted).toContain('***');
    expect(readSummary(root).reports).toEqual({
      nunit: ['tests/EditMode.xml'],
      junit: ['tests/EditMode.junit.xml'],
    });
  });

  it('converts NUnit to JUnit when unity left an empty JUnit file', async () => {
    testResponder = () => ({
      code: 0,
      nunit: readFileSync(new URL('./fixtures/editmode-pass.xml', import.meta.url), 'utf8'),
      junit: '',
    });
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'test')).toBe(0);

    const junitPath = join(root, 'ci-output', 'tests', 'EditMode.junit.xml');
    expect(readFileSync(junitPath, 'utf8')).toContain('<testsuites');
    expect(readSummary(root).reports).toMatchObject({
      junit: ['tests/EditMode.junit.xml'],
    });
  });

  it('does not convert when unity already produced a JUnit file', async () => {
    const junit = '<testsuites><testsuite name="unity-produced" /></testsuites>';
    testResponder = () => ({
      code: 0,
      nunit: readFileSync(new URL('./fixtures/editmode-pass.xml', import.meta.url), 'utf8'),
      junit,
    });
    const root = makeProject();
    const ctx = makeContext(root);

    expect(await runCommand(ctx, 'test')).toBe(0);

    // Unity is authoritative when it actually wrote something.
    expect(readFileSync(join(root, 'ci-output', 'tests', 'EditMode.junit.xml'), 'utf8')).toBe(
      junit,
    );
  });
});
