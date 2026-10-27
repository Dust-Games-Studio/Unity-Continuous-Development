import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { readEnvConfig } from '../src/config/env.js';

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

afterEach(() => {
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config precedence', () => {
  it('lets a CLI flag beat an env var and a config file', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'output:\n  dir: from-file\n');
    const { config, issues } = loadConfig({
      cwd: tmp,
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
    const { config, issues } = loadConfig({
      cwd: tmp,
      argv: {},
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
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {} });
    expect(config.output.dir).toBe('from-file');
    expect(issues).toEqual([]);
  });

  it('falls back to unity.ci.yml when unity-ci.yml is absent', () => {
    const tmp = workspace();
    write(tmp, 'unity.ci.yml', 'output:\n  dir: from-dotted-file\n');
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {} });
    expect(config.output.dir).toBe('from-dotted-file');
    expect(issues).toEqual([]);
  });

  it('merges a CLI boolean flag over the env and the file', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'output:\n  ci: true\n');
    const { config, issues } = loadConfig({
      cwd: tmp,
      argv: { ci: false },
      env: { UNITYCI_CI: 'true' },
      configFile,
    });
    expect(config.output.ci).toBe(false);
    expect(issues).toEqual([]);
  });
});

describe('environment mapping', () => {
  it('maps UNITYCI_TEST_MODES to test.modes', () => {
    const { patch, unknown } = readEnvConfig({ UNITYCI_TEST_MODES: 'EditMode,PlayMode' });
    expect(patch.test?.modes).toEqual(['EditMode', 'PlayMode']);
    expect(unknown).toEqual([]);

    const tmp = workspace();
    const { config } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_TEST_MODES: 'EditMode,PlayMode' },
    });
    expect(config.test.modes).toEqual(['EditMode', 'PlayMode']);
  });

  it('warns but does not fail on an unknown UNITYCI_ var', () => {
    const tmp = workspace();
    const { issues, unknownEnvVars } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_NOT_A_REAL_SETTING: '1' },
    });
    expect(unknownEnvVars).toContain('UNITYCI_NOT_A_REAL_SETTING');
    expect(issues).toEqual([]);
  });

  it('does not report UNITYCI_SECRET_* vars as unknown', () => {
    const { patch, unknown } = readEnvConfig({ UNITYCI_SECRET_DEPLOY_TOKEN: 'hunter2' });
    expect(unknown).toEqual([]);
    expect(patch).toEqual({});
  });

  it('merges a deep env var without erasing its sibling keys', () => {
    const tmp = workspace();
    const { config, issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_CLI_VERSION: '1.0.0-beta.9' },
    });
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

  it('ignores a boolean value that is not true or false, and reports it for a warning', () => {
    const { patch, unknown } = readEnvConfig({ UNITYCI_TEST_COVERAGE: 'yes' });
    expect(patch.test?.coverage).toBeUndefined();
    expect(unknown).toContain('UNITYCI_TEST_COVERAGE');
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
    const { issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(issues.some((i) => /secret/i.test(i.message))).toBe(true);
  });

  it('rejects a secret key nested deeper under license', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'license:\n  offline:\n    fileBase64: "aHVudGVyMg=="\n');
    const { issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
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
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(issues.length).toBeGreaterThan(0);
    expect(config.license.mode).toBe('none');
  });
});

describe('config file loading', () => {
  it('turns a malformed YAML file into an issue instead of throwing', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'unity:\n  cli: [unclosed\n');
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toBe(configFile);
    expect(config.unity.cli).toEqual(DEFAULT_CONFIG.unity.cli);
  });

  it('turns an explicitly requested but missing file into an issue', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: {},
      configFile: join(tmp, 'nope.yml'),
    });
    expect(issues.some((i) => /not found/i.test(i.message))).toBe(true);
  });

  it('reads --config from the parsed argv when no configFile is given', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'custom.yml', 'output:\n  dir: from-custom-file\n');
    const { config, issues } = loadConfig({ cwd: tmp, argv: { config: configFile }, env: {} });
    expect(config.output.dir).toBe('from-custom-file');
    expect(issues).toEqual([]);
  });

  it('never lets a YAML __proto__ key reach the prototype chain', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      '__proto__:\n  polluted: true\noutput:\n  dir: from-file\n',
    );
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.hasOwn(config, 'polluted')).toBe(false);
    expect(config.output.dir).toBe('from-file');
    expect(issues).toEqual([]);
  });
});

describe('config validation', () => {
  it('rejects latest unless allowLatest is true', () => {
    const tmp = workspace();
    const rejected = loadConfig({ cwd: tmp, argv: {}, env: { UNITYCI_CLI_VERSION: 'latest' } });
    expect(rejected.issues.some((i) => i.path === 'unity.cli.version')).toBe(true);
    expect(rejected.issues.some((i) => /allowLatest/.test(i.message))).toBe(true);

    const accepted = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_CLI_VERSION: 'latest', UNITYCI_CLI_ALLOW_LATEST: 'true' },
    });
    expect(accepted.issues).toEqual([]);
    expect(accepted.config.unity.cli.version).toBe('latest');
  });

  it('rejects exit code 8 in retry.onExitCodes', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_RETRY_EXIT_CODES: '7,8' },
    });
    expect(issues.some((i) => i.path === 'retry.onExitCodes' && /never retried/.test(i.message))).toBe(
      true,
    );
  });

  it('rejects exit code 130 or 143 in retry.onExitCodes', () => {
    const tmp = workspace();
    for (const code of ['130', '143']) {
      const { issues } = loadConfig({
        cwd: tmp,
        argv: {},
        env: { UNITYCI_RETRY_EXIT_CODES: `7,${code}` },
      });
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
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(config.retry.maxAttempts).toBe(2);
    expect(issues).toEqual([]);
  });

  it('leaves maxAttempts alone when exit code 6 is not enabled', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'retry:\n  onExitCodes: [7]\n  maxAttempts: 5\n',
    );
    const { config, issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(config.retry.maxAttempts).toBe(5);
    expect(issues).toEqual([]);
  });

  it('rejects a version string with a shell-unsafe character', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_CLI_VERSION: '6000.0.47f1; rm -rf /' },
    });
    expect(issues.some((i) => i.path === 'unity.cli.version')).toBe(true);
  });

  it('rejects an output dir that escapes the project root', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_OUTPUT_DIR: '../outside' },
    });
    expect(issues.some((i) => i.path === 'output.dir')).toBe(true);
  });

  it('rejects an absolute output dir outside the project root', () => {
    const tmp = workspace();
    const outside = resolve(tmp, '..', 'outside-the-project');
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_OUTPUT_DIR: outside },
    });
    expect(issues.some((i) => i.path === 'output.dir')).toBe(true);
  });

  it('rejects a report path that is an existing directory', () => {
    const tmp = workspace();
    // `unity test --output <dir>` runs the tests and writes no report at all,
    // silently. A build artifact path that is a directory is the same trap.
    mkdirSync(join(tmp, 'ci-output', 'build'), { recursive: true });
    const { issues } = loadConfig({ cwd: tmp, argv: {}, env: {} });
    expect(issues.some((i) => i.path === 'build.outputPath')).toBe(true);
  });

  it('rejects a test report file that is an existing directory', () => {
    const tmp = workspace();
    mkdirSync(join(tmp, 'ci-output', 'tests', 'EditMode.xml'), { recursive: true });
    const { issues } = loadConfig({ cwd: tmp, argv: {}, env: {} });
    expect(issues.some((i) => i.path === 'test.outputDir')).toBe(true);
  });

  it('rejects a test mode that is not EditMode or PlayMode', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_TEST_MODES: 'EditMode,SmokeMode' },
    });
    expect(issues.some((i) => i.path === 'test.modes')).toBe(true);
  });

  it('rejects an unknown license mode', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_LICENSE_MODE: 'always' },
    });
    expect(issues.some((i) => i.path === 'license.mode')).toBe(true);
  });

  it('rejects a non-integer maxAttempts', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'retry:\n  maxAttempts: 0\n');
    const { issues } = loadConfig({ cwd: tmp, argv: {}, env: {}, configFile });
    expect(issues.some((i) => i.path === 'retry.maxAttempts')).toBe(true);
  });

  it('accepts a normal config', () => {
    const tmp = workspace();
    const { config, issues, unknownEnvVars } = loadConfig({ cwd: tmp, argv: {}, env: {} });
    expect(issues).toEqual([]);
    expect(unknownEnvVars).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('accepts the from-project editor sentinel', () => {
    const tmp = workspace();
    const { issues } = loadConfig({
      cwd: tmp,
      argv: {},
      env: { UNITYCI_EDITOR_VERSION: 'from-project' },
    });
    expect(issues).toEqual([]);
  });
});
