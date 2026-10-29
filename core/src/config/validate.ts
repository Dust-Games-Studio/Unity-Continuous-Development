import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STRIPPED_ENV_VARIABLES } from '../exec.js';
import { EXIT } from '../exit-codes.js';
import type { Config, ConfigIssue } from './schema.js';

/** Allow-list for any value that reaches a path, URL or argv (GC15). */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** `from-project` is a sentinel; `latest` is opt-in through `allowLatest`. */
const VERSION_SENTINELS: ReadonlySet<string> = new Set(['from-project', 'latest']);

/** Codes the retry loop must never see: success, a failing suite, and interrupts. */
const NEVER_RETRY: ReadonlyMap<number, string> = new Map([
  [EXIT.SUCCESS, 'exit 0 is success'],
  [EXIT.TESTS_FAILED, 'the tests ran and some failed'],
  [EXIT.INTERRUPTED, 'the job was interrupted (SIGINT)'],
  [EXIT.TERMINATED, 'the job was terminated (SIGTERM)'],
]);

const LICENSE_MODES: ReadonlySet<string> = new Set([
  'none',
  'serial',
  'floating',
  'offline-file',
  'personal',
]);

const TEST_MODES: ReadonlySet<string> = new Set(['EditMode', 'PlayMode']);

const ANDROID_EXPORT_TYPES: ReadonlySet<string> = new Set([
  'apk',
  'aab',
  'android-studio-project',
]);

/** A path separator on either platform; both are rejected in a plain name. */
const PATH_SEPARATOR = /[\\/]/;

/**
 * `unity test --shard N/M`: both parts are 1-based and the shard index cannot
 * exceed the total. The CLI receives the string verbatim, so anything else is a
 * configuration error rather than an Editor-side surprise.
 */
const SHARD_SPEC = /^([0-9]+)\/([0-9]+)$/;

function shardIssue(value: unknown): string | null {
  const expected = 'test.shards must match N/M with 1 <= N <= M (for example 1/3)';
  if (typeof value !== 'string') {
    return `${expected}; got ${JSON.stringify(value)}`;
  }
  const match = SHARD_SPEC.exec(value);
  if (match === null) return `${expected}; got ${JSON.stringify(value)}`;

  const index = Number(match[1]);
  const total = Number(match[2]);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total
  ) {
    return `${expected}; got ${JSON.stringify(value)}`;
  }
  return null;
}

/** Control characters, including line breaks (YAML can smuggle either in). */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Validates `build.profile`: a plain profile name, or a path to a `.asset`
 * file (relative or absolute). The value reaches argv, so a leading `-` is an
 * argv injection (`--profile --output-path` would parse as two flags), a
 * control character or line break can forge a second line, and a `..` segment
 * would let the profile live outside the project. Returns the problem, or null.
 */
function buildProfileIssue(profile: string): string | null {
  if (profile.trim() === '') {
    return 'build.profile must be a non-empty path to a .asset file or a profile name, or null';
  }
  if (profile.startsWith('-')) {
    return 'build.profile must not start with "-": it would be parsed as another command-line option';
  }
  if (CONTROL_CHARACTER.test(profile)) {
    return 'build.profile must not contain control characters or line breaks';
  }
  if (profile.split(PATH_SEPARATOR).includes('..')) {
    return 'build.profile must not contain a ".." segment: the profile must live inside the project';
  }
  const isName = !PATH_SEPARATOR.test(profile);
  const isAssetPath = /\.asset$/i.test(profile);
  if (!isName && !isAssetPath) {
    return 'build.profile must be a plain profile name or a path ending in .asset';
  }
  return null;
}

const ANNOTATIONS: ReadonlySet<string> = new Set(['none', 'github']);

/**
 * The variables `spawnProcess` removes from every child (GC23). A licence
 * secret cannot be carried in one of these: it would be deleted before
 * `unity license activate` could read it, and the failure would name no cause.
 *
 * Compared case-insensitively: Windows environment names are case-insensitive,
 * and a case variant on POSIX is a nearly certain mistake rather than a
 * deliberate second variable.
 */
const STRIPPED_NAMES: ReadonlySet<string> = new Set(
  STRIPPED_ENV_VARIABLES.map((name) => name.toUpperCase()),
);

/** A configured env-var name must be usable and must survive the spawn strip. */
function checkSecretEnvName(
  path: string,
  value: unknown,
  issues: ConfigIssue[],
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: `${path} must be a non-empty environment variable name` });
    return;
  }
  if (STRIPPED_NAMES.has(value.toUpperCase())) {
    issues.push({
      path,
      message:
        `${path} must not name ${value}: the toolkit strips that variable from every child process ` +
        '(GC23), so the secret would never reach `unity license activate`. Choose a different variable name.',
    });
  }
}

/**
 * The `--output` flag is a **file** path. A directory is accepted silently and
 * Unity then writes no report at all, so a directory is a configuration error.
 */
function reportPathIssue(path: string, resolved: string, message: string): ConfigIssue | null {
  let isDirectory = false;
  try {
    isDirectory = statSync(resolved).isDirectory();
  } catch {
    // The path does not exist yet (or cannot be inspected): nothing to reject.
    return null;
  }
  return isDirectory ? { path, message } : null;
}

/**
 * Resolves a configured path against the project root and rejects escapes.
 * Returns the resolved path, or `null` when the value is unusable.
 */
function insideProjectRoot(
  path: string,
  value: unknown,
  projectRoot: string,
  issues: ConfigIssue[],
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: `${path} must be a non-empty string` });
    return null;
  }
  const resolved = resolve(projectRoot, value);
  const rel = relative(projectRoot, resolved);
  const escapes =
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith('../') ||
    isAbsolute(rel);
  if (escapes) {
    issues.push({
      path,
      message: `${path} must resolve inside the project root (${projectRoot}); got ${JSON.stringify(value)}`,
    });
    return null;
  }
  return resolved;
}

function checkVersionString(path: string, value: unknown, issues: ConfigIssue[]): void {
  if (typeof value !== 'string') {
    issues.push({ path, message: `${path} must be a string` });
    return;
  }
  if (VERSION_SENTINELS.has(value)) return;
  if (!SAFE_VERSION.test(value)) {
    issues.push({
      path,
      message: `${path} must match ${SAFE_VERSION.source} — it reaches argv and must not contain whitespace or shell metacharacters (got ${JSON.stringify(value)})`,
    });
  }
}

function checkNullableVersion(path: string, value: unknown, issues: ConfigIssue[]): void {
  if (value === null) return;
  checkVersionString(path, value, issues);
}

/**
 * Validates a merged configuration and returns every problem. It never throws,
 * never exits and **never mutates** the config it is given: the CLI entrypoint
 * turns a non-empty list into exit 64, and `loadConfig` applies the one repair
 * (the exit-code-6 retry cap) after validation.
 *
 * `projectRoot` is where `output.*` paths must resolve; it defaults to the
 * process working directory so the documented one-argument call still works.
 */
export function validateConfig(config: Config, projectRoot: string = process.cwd()): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const root = resolve(projectRoot);

  // --- versions -----------------------------------------------------------------
  checkVersionString('unity.cli.version', config.unity.cli.version, issues);
  checkNullableVersion('unity.editor.changeset', config.unity.editor.changeset, issues);
  checkVersionString('unity.editor.version', config.unity.editor.version, issues);

  // --- build target / profile ---------------------------------------------------
  // `unity build --target` is "Required unless --profile is used", so a build
  // needs one of them. An empty target is the unset value (the default is a
  // real target, so a profile-only build clears it).
  const profile = config.build.profile;
  const hasProfile = typeof profile === 'string' && profile.trim() !== '';
  if (profile !== null) {
    if (typeof profile !== 'string') {
      issues.push({
        path: 'build.profile',
        message: 'build.profile must be a path to a .asset file or a profile name, or null',
      });
    } else {
      const problem = buildProfileIssue(profile);
      if (problem !== null) issues.push({ path: 'build.profile', message: problem });
    }
  }

  const target = config.build.target;
  const hasTarget = typeof target === 'string' && target.trim() !== '';
  if (!hasProfile && !hasTarget) {
    issues.push({
      path: 'build.target',
      message:
        'build.target is empty and build.profile is null: a build needs one of them, because ' +
        '`unity build --target` is required unless `--profile` is used. Set build.target or build.profile',
    });
  } else if (hasTarget) {
    checkVersionString('build.target', target, issues);
  }
  // A profile is a path to a `.asset` file or a profile name; both may contain
  // spaces and slashes, so it is deliberately not checked as a version string.

  // --- Android build knobs ------------------------------------------------------
  const exportType = config.build.androidExportType;
  if (exportType !== null && !ANDROID_EXPORT_TYPES.has(exportType)) {
    issues.push({
      path: 'build.androidExportType',
      message:
        'build.androidExportType must be one of apk, aab, android-studio-project, or null; ' +
        `got ${JSON.stringify(exportType)}`,
    });
  }

  const targetSdk = config.build.androidTargetSdkVersion;
  if (targetSdk !== null && (!Number.isInteger(targetSdk) || targetSdk <= 0)) {
    issues.push({
      path: 'build.androidTargetSdkVersion',
      message: `build.androidTargetSdkVersion must be a positive integer, or null; got ${JSON.stringify(targetSdk)}`,
    });
  }

  if (typeof config.unity.cli.binary !== 'string' || config.unity.cli.binary.trim() === '') {
    issues.push({ path: 'unity.cli.binary', message: 'unity.cli.binary must be a non-empty command or path' });
  }

  for (const path of ['unity.cli.version', 'unity.editor.version'] as const) {
    const value = path === 'unity.cli.version' ? config.unity.cli.version : config.unity.editor.version;
    if (value === 'latest' && config.unity.cli.allowLatest !== true) {
      issues.push({
        path,
        message: `${path} is "latest", which is opt-in: set unity.cli.allowLatest: true to accept an untested CLI`,
      });
    }
  }

  // --- retry policy -------------------------------------------------------------
  const codes = config.retry.onExitCodes;
  if (!Array.isArray(codes)) {
    issues.push({ path: 'retry.onExitCodes', message: 'retry.onExitCodes must be a list of exit codes' });
  } else {
    for (const code of codes) {
      if (!Number.isInteger(code)) {
        issues.push({
          path: 'retry.onExitCodes',
          message: `retry.onExitCodes must contain integers; got ${JSON.stringify(code)}`,
        });
        continue;
      }
      const reason = NEVER_RETRY.get(code);
      if (reason !== undefined) {
        issues.push({
          path: 'retry.onExitCodes',
          message: `retry.onExitCodes must not contain ${code} (${reason}): this exit code is never retried`,
        });
      }
    }
  }

  if (!Number.isInteger(config.retry.maxAttempts) || config.retry.maxAttempts < 1) {
    issues.push({
      path: 'retry.maxAttempts',
      message: `retry.maxAttempts must be an integer of at least 1; got ${JSON.stringify(config.retry.maxAttempts)}`,
    });
  }

  // A negative or non-integer delay would reach `setTimeout`, which treats a
  // negative value as 0: the backoff would silently vanish instead of failing
  // loudly. 0 is allowed — it means "retry immediately".
  if (!Number.isInteger(config.retry.backoffMs) || config.retry.backoffMs < 0) {
    issues.push({
      path: 'retry.backoffMs',
      message: `retry.backoffMs must be an integer of at least 0; got ${JSON.stringify(config.retry.backoffMs)}`,
    });
  }

  // --- doctor -------------------------------------------------------------------
  if (
    !Number.isInteger(config.doctor.minFreeBytes) ||
    config.doctor.minFreeBytes <= 0
  ) {
    issues.push({
      path: 'doctor.minFreeBytes',
      message: `doctor.minFreeBytes must be a positive integer number of bytes; got ${JSON.stringify(config.doctor.minFreeBytes)}`,
    });
  }

  // --- test ---------------------------------------------------------------------
  const modes = config.test.modes;
  if (!Array.isArray(modes) || modes.length === 0) {
    issues.push({ path: 'test.modes', message: 'test.modes must contain at least one mode' });
  } else {
    for (const mode of modes) {
      if (typeof mode !== 'string' || !TEST_MODES.has(mode)) {
        issues.push({
          path: 'test.modes',
          message: `test.modes entries must be EditMode or PlayMode; got ${JSON.stringify(mode)}`,
        });
      }
    }
  }

  // `unity test --shard` takes `N/M` verbatim. Anything else reaches the Editor
  // and fails there with an opaque error, so the shape is checked here — env,
  // file and flag all pass through this validator.
  if (config.test.shards !== null) {
    const problem = shardIssue(config.test.shards);
    if (problem !== null) {
      issues.push({ path: 'test.shards', message: problem });
    }
  }

  // --- license / output enums ---------------------------------------------------
  if (!LICENSE_MODES.has(config.license.mode)) {
    issues.push({
      path: 'license.mode',
      message: `license.mode must be one of none, serial, floating, offline-file, personal; got ${JSON.stringify(config.license.mode)}`,
    });
  }
  // The serial and the offline file travel through the environment; refusing a
  // stripped name here turns a silent "activation cannot see the secret" into
  // exit 64 naming the setting.
  checkSecretEnvName('license.serialEnv', config.license.serialEnv, issues);
  checkSecretEnvName('license.fileEnv', config.license.fileEnv, issues);
  if (!ANNOTATIONS.has(config.output.annotations)) {
    issues.push({
      path: 'output.annotations',
      message: `output.annotations must be none or github; got ${JSON.stringify(config.output.annotations)}`,
    });
  }

  // --- paths --------------------------------------------------------------------
  // `output.dir` and `build.outputPath` are directories-or-files by design:
  // both only have to resolve inside the project root.
  insideProjectRoot('output.dir', config.output.dir, root, issues);
  insideProjectRoot('build.outputPath', config.build.outputPath, root, issues);
  const testOutputDir = insideProjectRoot(
    'test.outputDir',
    config.test.outputDir,
    root,
    issues,
  );

  if (testOutputDir !== null && Array.isArray(modes)) {
    // `unity test --output` takes a FILE. The core writes one NUnit report and
    // one JUnit report per mode: <test.outputDir>/<Mode>.xml and
    // <test.outputDir>/<Mode>.junit.xml.
    for (const mode of modes) {
      if (typeof mode !== 'string') continue;
      for (const suffix of ['.xml', '.junit.xml']) {
        const reportPath = join(testOutputDir, `${mode}${suffix}`);
        const issue = reportPathIssue(
          'test.outputDir',
          reportPath,
          `test.outputDir puts the ${mode} report at ${reportPath}, which is an existing directory; a report path must be a file — Unity accepts a directory silently and then writes no report at all`,
        );
        if (issue) issues.push(issue);
      }
    }
  }

  // `build.outputPath` may be a file or a directory (`unity build --profile
  // WebGL --output-path ./Build/WebGL` is documented as a directory), so the
  // existing-directory rule deliberately does not apply to it. It only has to
  // resolve inside the project root, checked above.

  return issues;
}
