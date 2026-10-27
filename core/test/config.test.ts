import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParseResult } from '../src/args.js';
import { readEnvConfig } from '../src/config/env.js';
import { loadConfig, type LoadConfigOptions, type LoadConfigResult } from '../src/config/load.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { validateConfig } from '../src/config/validate.js';

const workspaces: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-config-'));
  workspaces.push(dir);
  return dir;
}

function write(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

/** Loads with the project root and the working directory both set to `root`. */
function loadIn(root: string, overrides: Partial<LoadConfigOptions> = {}): LoadConfigResult {
  return loadConfig({ projectPath: root, cwd: root, argv: {}, env: {}, ...overrides });
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config precedence', () => {
  it('lets a CLI flag beat an env var and a config file', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'output:\n  dir: from-file\n');
    const { config, issues } = loadIn(tmp, {
      argv: { 'output-dir': 'from-flag' },
      env: { UNITYCI_OUTPUT_DIR: 'from-env' },
      configFile,
    });
    expect(config.output.dir).toBe('from-flag');
    expect(issues).toEqual([]);
  });

  it('lets an env var beat a config file', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'output:\n  dir: from-file\n');
    const { config, issues } = loadIn(tmp, {
      env: { UNITYCI_OUTPUT_DIR: 'from-env' },
      configFile,
    });
    expect(config.output.dir).toBe('from-env');
    expect(issues).toEqual([]);
  });

  it('uses the config file when nothing else is set', () => {
    const tmp = workspace();
    // Discovered by name: no configFile argument and no --config flag.
    write(tmp, 'unity-ci.yml', 'output:\n  dir: from-file\n');
    const { config, issues } = loadIn(tmp);
    expect(config.output.dir).toBe('from-file');
    expect(issues).toEqual([]);
  });

  it('falls back to unity.ci.yml when unity-ci.yml is absent', () => {
    const tmp = workspace();
    write(tmp, 'unity.ci.yml', 'output:\n  dir: from-dotted-file\n');
    const { config, issues } = loadIn(tmp);
    expect(config.output.dir).toBe('from-dotted-file');
    expect(issues).toEqual([]);
  });

  it('merges a CLI boolean flag over the env and the file', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'output:\n  ci: true\n');
    const { config, issues } = loadIn(tmp, {
      argv: { ci: false },
      env: { UNITYCI_CI: 'true' },
      configFile,
    });
    expect(config.output.ci).toBe(false);
    expect(issues).toEqual([]);
  });

  it("accepts the parser's full flags type, including boolean arrays", () => {
    const tmp = workspace();
    const flags: ParseResult['flags'] = { 'output-dir': 'from-typed-flags', verbose: [true, true] };
    const { config, issues } = loadIn(tmp, { argv: flags });
    expect(config.output.dir).toBe('from-typed-flags');
    expect(issues).toEqual([]);
  });
});

describe('environment mapping', () => {
  it('maps UNITYCI_TEST_MODES to test.modes', () => {
    const { patch, unknown, warnings } = readEnvConfig({ UNITYCI_TEST_MODES: 'EditMode,PlayMode' });
    expect(patch.test?.modes).toEqual(['EditMode', 'PlayMode']);
    expect(unknown).toEqual([]);
    expect(warnings).toEqual([]);

    const tmp = workspace();
    const { config } = loadIn(tmp, { env: { UNITYCI_TEST_MODES: 'EditMode,PlayMode' } });
    expect(config.test.modes).toEqual(['EditMode', 'PlayMode']);
  });

  it('warns but does not fail on an unknown UNITYCI_ var', () => {
    const tmp = workspace();
    const { issues, unknownEnvVars, warnings } = loadIn(tmp, {
      env: { UNITYCI_NOT_A_REAL_SETTING: '1' },
    });
    expect(unknownEnvVars).toContain('UNITYCI_NOT_A_REAL_SETTING');
    expect(warnings).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('puts a malformed known var in warnings, not in unknown', () => {
    const tmp = workspace();
    const fromEnv = readEnvConfig({ UNITYCI_TEST_COVERAGE: 'yes', UNITYCI_TYPO: '1' });
    expect(fromEnv.warnings).toEqual(['UNITYCI_TEST_COVERAGE']);
    expect(fromEnv.unknown).toEqual(['UNITYCI_TYPO']);
    expect(fromEnv.patch.test?.coverage).toBeUndefined();

    const { issues, unknownEnvVars, warnings } = loadIn(tmp, {
      env: { UNITYCI_TEST_COVERAGE: 'yes', UNITYCI_TYPO: '1' },
    });
    expect(warnings).toEqual(['UNITYCI_TEST_COVERAGE']);
    expect(unknownEnvVars).toEqual(['UNITYCI_TYPO']);
    expect(issues).toEqual([]);
  });

  it('does not report UNITYCI_SECRET_* vars as unknown', () => {
    const { patch, unknown, warnings } = readEnvConfig({ UNITYCI_SECRET_DEPLOY_TOKEN: 'hunter2' });
    expect(unknown).toEqual([]);
    expect(warnings).toEqual([]);
    expect(patch).toEqual({});
  });

  it('merges a deep env var without erasing its sibling keys', () => {
    const tmp = workspace();
    const { config, issues } = loadIn(tmp, { env: { UNITYCI_CLI_VERSION: '1.0.0-beta.9' } });
    expect(config.unity.cli).toEqual({
      version: '1.0.0-beta.9',
      allowLatest: DEFAULT_CONFIG.unity.cli.allowLatest,
      binary: DEFAULT_CONFIG.unity.cli.binary,
    });
    expect(issues).toEqual([]);
  });

  it('parses booleans case-insensitively', () => {
    const { patch } = readEnvConfig({ UNITYCI_TEST_COVERAGE: 'TRUE', UNITYCI_CI: 'False' });
    expect(patch.test?.coverage).toBe(true);
    expect(patch.output?.ci).toBe(false);
  });

  it('parses a comma-separated exit-code list as numbers', () => {
    const { patch } = readEnvConfig({ UNITYCI_RETRY_EXIT_CODES: '7,9,12,14' });
    expect(patch.retry?.onExitCodes).toEqual([7, 9, 12, 14]);
  });
});

describe('secrets', () => {
  it('rejects a unity-ci.yml that contains a secret key', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'license:\n  serial: "hunter2"\n');
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => /secret/i.test(i.message))).toBe(true);
  });

  it('rejects a secret key nested deeper under license', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'license:\n  offline:\n    fileBase64: "aHVudGVyMg=="\n',
    );
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => /secret/i.test(i.message))).toBe(true);
    expect(issues.some((i) => i.path.includes('fileBase64'))).toBe(true);
  });

  it('still returns the defaults alongside a secret issue', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'license:\n  serviceAccountSecret: "hunter2"\n',
    );
    const { config, issues } = loadIn(tmp, { configFile });
    expect(issues.length).toBeGreaterThan(0);
    expect(config.license.mode).toBe('none');
  });
});

describe('config file loading', () => {
  it('turns a malformed YAML file into an issue instead of throwing', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'unity:\n  cli: [unclosed\n');
    const { config, issues } = loadIn(tmp, { configFile });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe(configFile);
    expect(config.unity.cli).toEqual(DEFAULT_CONFIG.unity.cli);
  });

  it('turns an explicitly requested but missing file into an issue', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { configFile: join(tmp, 'nope.yml') });
    expect(issues.some((i) => /not found/i.test(i.message))).toBe(true);
  });

  it('reads --config from the parsed argv when no configFile is given', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'custom.yml', 'output:\n  dir: from-custom-file\n');
    const { config, issues } = loadIn(tmp, { argv: { config: configFile } });
    expect(config.output.dir).toBe('from-custom-file');
    expect(issues).toEqual([]);
  });

  it('discovers unity-ci.yml at the project root, not at the working directory', () => {
    const project = workspace();
    const cwd = workspace();
    write(project, 'unity-ci.yml', 'output:\n  dir: from-project-root\n');
    // A stray file at the invocation directory must be ignored.
    write(cwd, 'unity-ci.yml', 'output:\n  dir: from-cwd\n');

    const { config, issues } = loadIn(project, { cwd });
    expect(config.output.dir).toBe('from-project-root');
    expect(issues).toEqual([]);
  });

  it('returns the resolved project path', () => {
    const project = workspace();
    const cwd = workspace();
    const absolute = loadIn(project, { cwd });
    expect(absolute.projectPath).toBe(resolve(project));
    expect(absolute.issues).toEqual([]);

    const relative = loadConfig({
      projectPath: '.',
      cwd: project,
      argv: {},
      env: {},
    });
    expect(relative.projectPath).toBe(resolve(project));
  });

  it('never lets a YAML __proto__ key reach the prototype chain', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      '__proto__:\n  polluted: true\noutput:\n  dir: from-file\n',
    );
    const { config, issues } = loadIn(tmp, { configFile });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.hasOwn(config, 'polluted')).toBe(false);
    expect(config.output.dir).toBe('from-file');
    expect(issues).toEqual([]);
  });
});

describe('config validation', () => {
  it('rejects latest unless allowLatest is true', () => {
    const tmp = workspace();
    const rejected = loadIn(tmp, { env: { UNITYCI_CLI_VERSION: 'latest' } });
    expect(rejected.issues.some((i) => i.path === 'unity.cli.version')).toBe(true);
    expect(rejected.issues.some((i) => /allowLatest/.test(i.message))).toBe(true);

    const accepted = loadIn(tmp, {
      env: { UNITYCI_CLI_VERSION: 'latest', UNITYCI_CLI_ALLOW_LATEST: 'true' },
    });
    expect(accepted.issues).toEqual([]);
    expect(accepted.config.unity.cli.version).toBe('latest');
  });

  it('rejects exit code 8 in retry.onExitCodes', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_RETRY_EXIT_CODES: '7,8' } });
    expect(issues.some((i) => i.path === 'retry.onExitCodes' && /never retried/.test(i.message))).toBe(
      true,
    );
  });

  it('rejects exit code 130 or 143 in retry.onExitCodes', () => {
    const tmp = workspace();
    for (const code of ['130', '143']) {
      const { issues } = loadIn(tmp, { env: { UNITYCI_RETRY_EXIT_CODES: `7,${code}` } });
      expect(
        issues.some((i) => i.path === 'retry.onExitCodes' && /never retried/.test(i.message)),
      ).toBe(true);
    }
  });

  it('caps exit code 6 at one extra attempt when it is enabled', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'retry:\n  onExitCodes: [6]\n  maxAttempts: 5\n',
    );
    const { config, issues } = loadIn(tmp, { configFile });
    expect(config.retry.maxAttempts).toBe(2);
    expect(issues).toEqual([]);
  });

  it('the loader applies the exit-code-6 cap, not the validator', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'retry:\n  onExitCodes: [7, 6]\n  maxAttempts: 5\n',
    );

    // The validator alone leaves the value untouched.
    const direct = structuredClone(DEFAULT_CONFIG);
    direct.retry.onExitCodes = [7, 6];
    direct.retry.maxAttempts = 5;
    expect(validateConfig(direct, tmp)).toEqual([]);
    expect(direct.retry.maxAttempts).toBe(5);

    // The loader applies the cap to the merged config.
    const { config, issues } = loadIn(tmp, { configFile });
    expect(config.retry.maxAttempts).toBe(2);
    expect(issues).toEqual([]);
  });

  it('validateConfig returns issues and does not mutate the config it is given', () => {
    const tmp = workspace();
    const config = structuredClone(DEFAULT_CONFIG);
    config.retry.onExitCodes = [7, 6];
    config.retry.maxAttempts = 5;
    config.test.modes = ['EditMode', 'PlayMode'];
    const before = structuredClone(config);

    const issues = validateConfig(config, tmp);

    expect(issues).toEqual([]);
    expect(config).toEqual(before);
    expect(config.retry.maxAttempts).toBe(5);
  });

  it('validateConfig leaves retry.maxAttempts alone when exit code 6 is absent', () => {
    const tmp = workspace();
    const config = structuredClone(DEFAULT_CONFIG);
    config.retry.onExitCodes = [7, 9];
    config.retry.maxAttempts = 5;

    const issues = validateConfig(config, tmp);

    expect(issues).toEqual([]);
    expect(config.retry.maxAttempts).toBe(5);
  });

  it('leaves maxAttempts alone when exit code 6 is not enabled', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'retry:\n  onExitCodes: [7]\n  maxAttempts: 5\n',
    );
    const { config, issues } = loadIn(tmp, { configFile });
    expect(config.retry.maxAttempts).toBe(5);
    expect(issues).toEqual([]);
  });

  it('rejects a version string with a shell-unsafe character', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_CLI_VERSION: '6000.0.47f1; rm -rf /' } });
    expect(issues.some((i) => i.path === 'unity.cli.version')).toBe(true);
  });

  it('rejects an output dir that escapes the project root', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_OUTPUT_DIR: '../outside' } });
    expect(issues.some((i) => i.path === 'output.dir')).toBe(true);
  });

  it('rejects an absolute output dir outside the project root', () => {
    const tmp = workspace();
    const outside = resolve(tmp, '..', 'outside-the-project');
    const { issues } = loadIn(tmp, { env: { UNITYCI_OUTPUT_DIR: outside } });
    expect(issues.some((i) => i.path === 'output.dir')).toBe(true);
  });

  it('rejects a report path that is an existing directory', () => {
    const tmp = workspace();
    // `unity test --output <dir>` runs the tests and writes no report at all,
    // silently.
    mkdirSync(join(tmp, 'ci-output', 'tests', 'EditMode.xml'), { recursive: true });
    const { issues } = loadIn(tmp);
    expect(issues.some((i) => i.path === 'test.outputDir')).toBe(true);
  });

  it('rejects a JUnit report path that is an existing directory', () => {
    const tmp = workspace();
    mkdirSync(join(tmp, 'ci-output', 'tests', 'EditMode.junit.xml'), { recursive: true });
    const { issues } = loadIn(tmp);
    expect(issues.some((i) => i.path === 'test.outputDir')).toBe(true);
  });

  it('honours a non-default test.outputDir when checking report paths', () => {
    const tmp = workspace();
    write(tmp, 'unity-ci.yml', 'test:\n  outputDir: reports\n');
    mkdirSync(join(tmp, 'reports', 'EditMode.xml'), { recursive: true });
    const { issues } = loadIn(tmp);
    expect(issues.some((i) => i.path === 'test.outputDir')).toBe(true);
  });

  it('checks the configured report directory, not the default one', () => {
    const tmp = workspace();
    write(tmp, 'unity-ci.yml', 'test:\n  outputDir: reports\n');
    // The default directory is a decoy: only `<test.outputDir>/<Mode>.xml` counts.
    mkdirSync(join(tmp, 'ci-output', 'tests', 'EditMode.xml'), { recursive: true });
    const { issues } = loadIn(tmp);
    expect(issues).toEqual([]);
  });

  it('accepts a build output path that is an existing directory', () => {
    const tmp = workspace();
    // `unity build --output-path ./Build/WebGL` is documented as a directory
    // for directory-style targets, and `ci-output/build/` holds the build's
    // files and provenance.json after the first successful build.
    mkdirSync(join(tmp, 'ci-output', 'build', 'game'), { recursive: true });
    const { config, issues } = loadIn(tmp);
    expect(config.build.outputPath).toBe('ci-output/build/game');
    expect(issues).toEqual([]);
  });

  it('rejects a test mode that is not EditMode or PlayMode', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_TEST_MODES: 'EditMode,SmokeMode' } });
    expect(issues.some((i) => i.path === 'test.modes')).toBe(true);
  });

  it('rejects an unknown license mode', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_LICENSE_MODE: 'always' } });
    expect(issues.some((i) => i.path === 'license.mode')).toBe(true);
  });

  it('rejects a non-integer maxAttempts', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'retry:\n  maxAttempts: 0\n');
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => i.path === 'retry.maxAttempts')).toBe(true);
  });

  it('accepts a normal config', () => {
    const tmp = workspace();
    const { config, issues, unknownEnvVars, warnings, projectPath } = loadIn(tmp);
    expect(issues).toEqual([]);
    expect(unknownEnvVars).toEqual([]);
    expect(warnings).toEqual([]);
    expect(projectPath).toBe(resolve(tmp));
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('accepts the from-project editor sentinel', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_EDITOR_VERSION: 'from-project' } });
    expect(issues).toEqual([]);
  });
});
