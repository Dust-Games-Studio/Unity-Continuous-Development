import { statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.js';
import type { Config, ConfigIssue } from './schema.js';

/** Allow-list for any value that reaches a path, URL or argv (GC15). */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** `from-project` is a sentinel; `latest` is opt-in through `allowLatest`. */
const VERSION_SENTINELS: ReadonlySet<string> = new Set(['from-project', 'latest']);

/** Codes the retry loop must never see: a failing suite, SIGINT and SIGTERM. */
const NEVER_RETRY: ReadonlyMap<number, string> = new Map([
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

const ANNOTATIONS: ReadonlySet<string> = new Set(['none', 'github']);

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
  checkVersionString('build.target', config.build.target, issues);
  checkNullableVersion('build.profile', config.build.profile, issues);

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

  // --- license / output enums ---------------------------------------------------
  if (!LICENSE_MODES.has(config.license.mode)) {
    issues.push({
      path: 'license.mode',
      message: `license.mode must be one of none, serial, floating, offline-file, personal; got ${JSON.stringify(config.license.mode)}`,
    });
  }
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
