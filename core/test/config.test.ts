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

  it('rejects every environment-only secret name as a key, at any depth', () => {
    const names = [
      'UNITY_LICENSE_SERIAL',
      'UNITY_LICENSE_FILE_BASE64',
      'UNITY_SERVICE_ACCOUNT_ID',
      'UNITY_SERVICE_ACCOUNT_SECRET',
      'UNITYCI_SECRET_MY_TOKEN',
    ];

    for (const name of names) {
      for (const [body, expectedPath] of [
        [`${name}: abc\n`, name],
        [`unity:\n  cli:\n    ${name}: abc\n`, `unity.cli.${name}`],
      ] as const) {
        const tmp = workspace();
        const configFile = write(tmp, 'unity-ci.yml', body);
        const { issues } = loadIn(tmp, { configFile });

        const hit = issues.find((issue) => issue.path === expectedPath);
        expect(hit, `${name} at ${expectedPath}`).toBeDefined();
        // The message names the variable to set, never the value beside it.
        expect(hit?.message).toContain(name);
        expect(hit?.message).toMatch(/environment/i);
        expect(hit?.message).not.toContain('abc');
      }
    }
  });

  it('rejects case and separator variants of a secret key', () => {
    for (const key of [
      'unity_license_serial',
      'unity-license-serial',
      'Unity-License-Serial',
      'unityci-secret-token',
    ]) {
      const tmp = workspace();
      const configFile = write(tmp, 'unity-ci.yml', `${key}: abc\n`);
      const { issues } = loadIn(tmp, { configFile });

      expect(
        issues.some((issue) => issue.path === key),
        `expected ${key} to be rejected`,
      ).toBe(true);

      const hit = issues.find((issue) => issue.path === key);
      // The remedy names the environment variable, not the misspelling.
      expect(hit?.message).toContain(
        key.toLowerCase().startsWith('unityci')
          ? 'UNITYCI_SECRET_TOKEN'
          : 'UNITY_LICENSE_SERIAL',
      );
    }
  });

  it('rejects a string value that names a secret channel', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'test:\n  filter: UNITY_LICENSE_SERIAL\n',
    );
    const { issues } = loadIn(tmp, { configFile });

    const hit = issues.find((issue) => issue.path === 'test.filter');
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('UNITY_LICENSE_SERIAL');
    expect(hit?.message).toMatch(/environment/i);
  });

  it('rejects a secret-channel string inside an array', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'test:\n  modes:\n    - UNITYCI_SECRET_MODE\n',
    );
    const { issues } = loadIn(tmp, { configFile });

    expect(
      issues.some(
        (issue) =>
          issue.path === 'test.modes[0]' && /secret channel/.test(issue.message),
      ),
    ).toBe(true);
  });

  it('does not reject a legitimate key that merely contains a word', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      [
        'output:',
        '  ci: true',
        '  dir: unity',
        'unity:',
        '  editor:',
        '    version: from-project',
        'test:',
        '  modes: [EditMode]',
        'license:',
        '  mode: none',
        '  # These two values are the variable *names* to read, not secrets.',
        '  serialEnv: UNITY_LICENSE_SERIAL',
        '  fileEnv: UNITY_LICENSE_FILE_BASE64',
        '',
      ].join('\n'),
    );
    const { config, issues } = loadIn(tmp, { configFile });

    expect(issues).toEqual([]);
    expect(config.license.serialEnv).toBe('UNITY_LICENSE_SERIAL');
    expect(config.license.fileEnv).toBe('UNITY_LICENSE_FILE_BASE64');
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

  it('rejects exit code 0 in retry.onExitCodes', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_RETRY_EXIT_CODES: '0,7' } });
    expect(
      issues.some(
        (i) =>
          i.path === 'retry.onExitCodes' && /success/.test(i.message) && /never retried/.test(i.message),
      ),
    ).toBe(true);
  });

  it('rejects a negative or non-integer retry.backoffMs', () => {
    const tmp = workspace();
    for (const value of ['-1', '1500.5']) {
      const configFile = write(tmp, 'unity-ci.yml', `retry:\n  backoffMs: ${value}\n`);
      const { issues } = loadIn(tmp, { configFile });
      expect(issues.some((i) => i.path === 'retry.backoffMs')).toBe(true);
    }
  });

  it('accepts a zero retry.backoffMs', () => {
    // 0 is a deliberate "retry immediately", not a missing value.
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'retry:\n  backoffMs: 0\n');
    const { config, issues } = loadIn(tmp, { configFile });
    expect(config.retry.backoffMs).toBe(0);
    expect(issues).toEqual([]);
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

  it('accepts a shard specification in N/M form', () => {
    const tmp = workspace();
    const { config, issues } = loadIn(tmp, { env: { UNITYCI_TEST_SHARDS: '1/3' } });
    expect(config.test.shards).toBe('1/3');
    expect(issues).toEqual([]);
  });

  it('rejects a malformed or impossible shard specification', () => {
    for (const value of ['2', '1/', '0/3', '4/3', '1 / 3']) {
      const tmp = workspace();
      const { issues } = loadIn(tmp, { env: { UNITYCI_TEST_SHARDS: value } });
      const issue = issues.find((entry) => entry.path === 'test.shards');
      expect(issue, `expected test.shards to reject ${JSON.stringify(value)}`).toBeDefined();
      expect(issue?.message).toContain('N/M');
      expect(issue?.message).toContain('1 <= N <= M');
    }
  });

  it('rejects a numeric shards value from a config file', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'test:\n  shards: 2\n');
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((issue) => issue.path === 'test.shards')).toBe(true);
  });

  it('accepts a build output path that is an existing directory', () => {
    const tmp = workspace();
    // `unity build --output ./Build/WebGL` is documented as a directory
    // for directory-style targets, and `ci-output/build/` holds the build's
    // files and provenance.json after the first successful build.
    mkdirSync(join(tmp, 'ci-output', 'build', 'game'), { recursive: true });
    const { config, issues } = loadIn(tmp);
    expect(config.build.outputPath).toBe('ci-output/build/game');
    expect(issues).toEqual([]);
  });

  it('defaults the Android build knobs to null so no flag is sent', () => {
    const tmp = workspace();
    const { config, issues } = loadIn(tmp);
    expect(config.build.androidExportType).toBeNull();
    expect(config.build.androidTargetSdkVersion).toBeNull();
    expect(issues).toEqual([]);
  });

  it('accepts every Android export type and a positive target SDK', () => {
    for (const type of ['apk', 'aab', 'android-studio-project']) {
      const tmp = workspace();
      const configFile = write(
        tmp,
        'unity-ci.yml',
        `build:\n  androidExportType: ${type}\n  androidTargetSdkVersion: 34\n`,
      );
      const { config, issues } = loadIn(tmp, { configFile });
      expect(issues).toEqual([]);
      expect(config.build.androidExportType).toBe(type);
      expect(config.build.androidTargetSdkVersion).toBe(34);
    }
  });

  it('rejects an unknown Android export type', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'build:\n  androidExportType: ipa\n');
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => i.path === 'build.androidExportType')).toBe(true);
    // The three CLI choices are named in the message.
    const issue = issues.find((i) => i.path === 'build.androidExportType');
    expect(issue?.message).toContain('apk, aab, android-studio-project');
  });

  it('rejects a non-positive or non-integer Android target SDK', () => {
    for (const value of ['0', '-1', '33.5', '"34"']) {
      const tmp = workspace();
      const configFile = write(
        tmp,
        'unity-ci.yml',
        `build:\n  androidTargetSdkVersion: ${value}\n`,
      );
      const { issues } = loadIn(tmp, { configFile });
      expect(issues.some((i) => i.path === 'build.androidTargetSdkVersion')).toBe(true);
    }
  });

  it('accepts a Unity build profile path with spaces', () => {
    const tmp = workspace();
    const profile = 'Assets/Settings/Build Profiles/Windows Release.asset';
    const configFile = write(tmp, 'unity-ci.yml', `build:\n  profile: ${profile}\n`);
    const { config, issues } = loadIn(tmp, { configFile });
    expect(issues).toEqual([]);
    expect(config.build.profile).toBe(profile);
  });

  it('accepts a build profile name', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'build:\n  profile: Windows Release\n');
    const { config, issues } = loadIn(tmp, { configFile });
    expect(issues).toEqual([]);
    expect(config.build.profile).toBe('Windows Release');
  });

  it('accepts an absolute .asset profile path', () => {
    for (const profile of [
      'C:\\Build Profiles\\Windows Release.asset',
      '/opt/profiles/Linux.asset',
    ]) {
      const tmp = workspace();
      const configFile = write(tmp, 'unity-ci.yml', `build:\n  profile: "${profile.replace(/\\/g, '\\\\')}"\n`);
      const { config, issues } = loadIn(tmp, { configFile });
      expect(issues).toEqual([]);
      expect(config.build.profile).toBe(profile);
    }
  });

  it('rejects an empty build profile', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'build:\n  profile: ""\n');
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => i.path === 'build.profile')).toBe(true);
  });

  it('rejects a profile that starts with - as an argv injection', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'build:\n  profile: --output-path\n');
    const { issues } = loadIn(tmp, { configFile });
    const issue = issues.find((i) => i.path === 'build.profile');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('must not start with "-"');
  });

  it('rejects a profile containing a line break or control character', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'build:\n  profile: "Assets/Settings\\nWindows.asset"\n',
    );
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => i.path === 'build.profile')).toBe(true);
  });

  it('rejects a profile containing a .. segment', () => {
    for (const profile of [
      '../outside/Windows.asset',
      'Assets/../Windows.asset',
      'Assets\\..\\Windows.asset',
    ]) {
      const tmp = workspace();
      const configFile = write(tmp, 'unity-ci.yml', `build:\n  profile: "${profile.replace(/\\/g, '\\\\')}"\n`);
      const { issues } = loadIn(tmp, { configFile });
      const issue = issues.find((i) => i.path === 'build.profile');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('".." segment');
    }
  });

  it('rejects a path that does not end in .asset', () => {
    for (const profile of ['Assets/Settings/Windows', 'Assets/Settings/Windows.txt']) {
      const tmp = workspace();
      const configFile = write(tmp, 'unity-ci.yml', `build:\n  profile: ${profile}\n`);
      const { issues } = loadIn(tmp, { configFile });
      const issue = issues.find((i) => i.path === 'build.profile');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('path ending in .asset');
    }
  });

  it('requires a build target unless a profile is configured', () => {
    for (const target of ['""', 'null']) {
      const tmp = workspace();
      const configFile = write(tmp, 'unity-ci.yml', `build:\n  target: ${target}\n`);
      const { issues } = loadIn(tmp, { configFile });
      const issue = issues.find((i) => i.path === 'build.target');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('--target');
      expect(issue?.message).toContain('--profile');
    }
  });

  it('accepts an unset target when a profile defines it', () => {
    const tmp = workspace();
    const configFile = write(tmp, 'unity-ci.yml', 'build:\n  target: ""\n  profile: Windows\n');
    const { issues } = loadIn(tmp, { configFile });
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

  it('rejects a serial env var the spawn layer strips', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'license:\n  mode: serial\n  serialEnv: UNITY_SERVICE_ACCOUNT_SECRET\n',
    );
    const { issues } = loadIn(tmp, { configFile });
    expect(
      issues.some(
        (i) => i.path === 'license.serialEnv' && /strips that variable/.test(i.message),
      ),
    ).toBe(true);
    // The message must name the variable and the reason, or the user has no
    // way to know why their serial is invisible to `unity license activate`.
    expect(issues.some((i) => i.message.includes('UNITY_SERVICE_ACCOUNT_SECRET'))).toBe(true);
  });

  it('rejects a licence file env var the spawn layer strips, case-insensitively', () => {
    const tmp = workspace();
    for (const name of ['UNITY_GITHUB_TOKEN', 'unity_gitlab_token']) {
      write(tmp, 'unity-ci.yml', `license:\n  mode: offline-file\n  fileEnv: ${name}\n`);
      const { issues } = loadIn(tmp, { configFile: join(tmp, 'unity-ci.yml') });
      expect(issues.some((i) => i.path === 'license.fileEnv'), name).toBe(true);
    }
  });

  it('rejects an empty licence env var name', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'license:\n  mode: serial\n  serialEnv: ""\n',
    );
    const { issues } = loadIn(tmp, { configFile });
    expect(issues.some((i) => i.path === 'license.serialEnv')).toBe(true);
  });

  it('accepts a custom licence env var name that is not stripped', () => {
    const tmp = workspace();
    const configFile = write(
      tmp,
      'unity-ci.yml',
      'license:\n  mode: serial\n  serialEnv: MY_LICENSE_SERIAL\n',
    );
    const { config, issues } = loadIn(tmp, { configFile });
    expect(config.license.serialEnv).toBe('MY_LICENSE_SERIAL');
    expect(issues).toEqual([]);
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

describe('1.0.x configuration surface', () => {
  it('defaults the new switches to off and provenance to on', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    expect(config.unity.editor.headless).toBe(false);
    expect(config.unity.editor.resume).toBe(false);
    expect(config.unity.editor.path).toBeNull();
    expect(config.unity.editor.architecture).toBeNull();
    expect(config.test.affected).toBe(false);
    expect(config.test.affectedCompare).toBeNull();
    expect(config.test.since).toBeNull();
    expect(config.test.rerunFailed).toBe(false);
    expect(config.build.provenance).toBe(true);
    expect(config.build.buildTargetGroup).toBeNull();
    expect(config.doctor.skipLicense).toBe(false);
    expect(config.accelerator).toEqual({ endpoint: null, disabled: false });
  });

  it('maps every new environment variable', () => {
    const { patch, unknown } = readEnvConfig({
      UNITYCI_EDITOR_HEADLESS: 'true',
      UNITYCI_EDITOR_RESUME: 'true',
      UNITYCI_EDITOR_PATH: '/opt/unity/Editor/Unity',
      UNITYCI_EDITOR_ARCHITECTURE: 'arm64',
      UNITYCI_TEST_AFFECTED: 'true',
      UNITYCI_TEST_AFFECTED_COMPARE: 'origin/main',
      UNITYCI_TEST_SINCE: 'origin/main',
      UNITYCI_TEST_RERUN_FAILED: 'true',
      UNITYCI_BUILD_PROVENANCE: 'false',
      UNITYCI_BUILD_TARGET_GROUP: 'Standalone',
      UNITYCI_DOCTOR_SKIP_LICENSE: 'true',
      UNITYCI_ACCELERATOR: 'accelerator.local:10080',
      UNITYCI_ACCELERATOR_DISABLED: 'true',
    });
    expect(unknown).toEqual([]);
    expect(patch.unity?.editor).toMatchObject({
      headless: true,
      resume: true,
      path: '/opt/unity/Editor/Unity',
      architecture: 'arm64',
    });
    expect(patch.test).toMatchObject({
      affected: true,
      affectedCompare: 'origin/main',
      since: 'origin/main',
      rerunFailed: true,
    });
    expect(patch.build).toMatchObject({ provenance: false, buildTargetGroup: 'Standalone' });
    expect(patch.doctor?.skipLicense).toBe(true);
    expect(patch.accelerator).toEqual({ endpoint: 'accelerator.local:10080', disabled: true });
  });

  it('rejects an unknown editor architecture', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_EDITOR_ARCHITECTURE: 'mips' } });
    expect(issues.some((issue) => issue.path === 'unity.editor.architecture')).toBe(true);
  });

  it('accepts the two Editor architectures the CLI supports', () => {
    for (const architecture of ['x86_64', 'arm64']) {
      const tmp = workspace();
      const { issues } = loadIn(tmp, { env: { UNITYCI_EDITOR_ARCHITECTURE: architecture } });
      expect(issues).toEqual([]);
    }
  });

  it('rejects an Editor path that would parse as another option', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_EDITOR_PATH: '--output=/tmp/x' } });
    expect(issues.some((issue) => issue.path === 'unity.editor.path')).toBe(true);
  });

  it('rejects a since ref that would parse as another option', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_TEST_SINCE: '--output-path' } });
    expect(issues.some((issue) => issue.path === 'test.since')).toBe(true);
  });

  it('rejects a malformed accelerator endpoint', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, { env: { UNITYCI_ACCELERATOR: 'host:not-a-port' } });
    expect(issues.some((issue) => issue.path === 'accelerator.endpoint')).toBe(true);
  });

  it('rejects an endpoint and --no-accelerator at the same time', () => {
    const tmp = workspace();
    const { issues } = loadIn(tmp, {
      env: { UNITYCI_ACCELERATOR: 'accelerator:10080', UNITYCI_ACCELERATOR_DISABLED: 'true' },
    });
    expect(issues.some((issue) => issue.path === 'accelerator')).toBe(true);
  });
});
