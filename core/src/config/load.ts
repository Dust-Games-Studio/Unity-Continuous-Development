import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { ParseResult } from '../args.js';
import { EXIT } from '../exit-codes.js';
import { readEnvConfig, type DeepPartial } from './env.js';
import { DEFAULT_CONFIG, type Config, type ConfigIssue } from './schema.js';
import { validateConfig } from './validate.js';

/** The config file names looked up in `cwd`, in order, when `--config` is absent. */
const CONFIG_FILENAMES = ['unity-ci.yml', 'unity.ci.yml'] as const;

/**
 * License keys that must never reach a file. GC5: license material and Unity
 * service-account credentials are environment-only or git-configuration-only
 * — never a config file, a flag or a command line.
 */
const LICENSE_SECRET_KEYS: ReadonlySet<string> = new Set([
  'serial',
  'filebase64',
  'serviceaccountid',
  'serviceaccountsecret',
]);

/**
 * The environment-only secret names (GC5). Matching is case-insensitive and
 * tolerates `_`/`-` spelling variants, so a committed `unity-license-serial`
 * key cannot slip past a camelCase-only check. `UNITYCI_SECRET_*` is a prefix,
 * not one of the exact names.
 */
const SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  'UNITY_LICENSE_SERIAL',
  'UNITY_LICENSE_FILE_BASE64',
  'UNITY_SERVICE_ACCOUNT_ID',
  'UNITY_SERVICE_ACCOUNT_SECRET',
]);

/**
 * The two settings whose *value* is legitimately an environment-variable name.
 * `license.serialEnv` and `license.fileEnv` exist to say which variable to read;
 * rejecting `UNITY_LICENSE_SERIAL` there would reject the documented config and
 * the built-in default.
 */
const SECRET_ENV_NAME_SETTINGS: ReadonlySet<string> = new Set([
  'license.serialEnv',
  'license.fileEnv',
]);

function normaliseEnvName(name: string): string {
  return name.trim().toUpperCase().replace(/-/g, '_');
}

/** Whether a key or string value names an environment-only secret channel. */
function isSecretEnvName(name: string): boolean {
  const normalised = normaliseEnvName(name);
  return (
    normalised.startsWith('UNITYCI_SECRET_') || SECRET_ENV_NAMES.has(normalised)
  );
}

function childPath(parent: string, child: string | number): string {
  if (typeof child === 'number') return `${parent}[${child}]`;
  return parent === '' ? child : `${parent}.${child}`;
}

/** The environment-variable form of a name, for the message that tells the user what to set. */
function canonicalSecretName(name: string): string {
  return normaliseEnvName(name);
}

/**
 * A secret name used as a **key**. The message names the variable to set in the
 * environment and the offending path, never the value beside it.
 */
function secretKeyIssue(path: string, variable: string): ConfigIssue {
  const canonical = canonicalSecretName(variable);
  return {
    path,
    message:
      `${path} is an environment variable name used as a config key. Secrets are ` +
      `environment-only: set ${canonical} in the environment and remove this key from the file.`,
  };
}

/**
 * A secret name used as a **value** (for example `serial: UNITY_LICENSE_SERIAL`).
 * The value is the channel name, not the secret itself, so naming it tells the
 * reader exactly which variable to set.
 */
function secretValueIssue(path: string, variable: string): ConfigIssue {
  const canonical = canonicalSecretName(variable);
  return {
    path,
    message:
      `${path} names the secret channel ${canonical}. The secret belongs in the ` +
      `environment, not in a config file: set ${canonical} in the environment and remove it from the file.`,
  };
}

export interface LoadConfigOptions {
  /** The already-resolved Unity project root; the config file is read from here. */
  projectPath: string;
  /** The invocation directory. Only used to resolve relative paths (e.g. `--config`). */
  cwd: string;
  /** The already-parsed flags, exactly as the parser produces them. */
  argv: ParseResult['flags'];
  env: NodeJS.ProcessEnv;
  /** An explicit config file (the caller's `--config`), if any. */
  configFile?: string;
}

export interface LoadConfigResult {
  config: Config;
  issues: ConfigIssue[];
  unknownEnvVars: string[];
  warnings: string[];
  /** The resolved project root, echoed back so callers never recompute it. */
  projectPath: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T;
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry);
    return copy as T;
  }
  return value;
}

/**
 * Merges `patch` over `base` recursively: objects merge key by key, arrays and
 * scalars replace, and an absent (`undefined`) patch value leaves the lower
 * layer alone. Keys that do not exist in `base` are ignored, so the shape of
 * `Config` is owned by `DEFAULT_CONFIG`. `base` is never mutated.
 */
function mergeDeep<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base)) {
    return (patch === undefined ? base : (patch as unknown as T)) as T;
  }
  const output: Record<string, unknown> = {};
  for (const [key, current] of Object.entries(base)) {
    output[key] = cloneValue(current);
  }
  if (!isPlainObject(patch)) return output as T;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // Own keys only: a YAML `__proto__` or `constructor` key must never reach
    // the prototype chain.
    if (!Object.hasOwn(output, key)) continue;
    const current = output[key];
    const currentIsObject = isPlainObject(current);
    const valueIsObject = isPlainObject(value);
    if (currentIsObject && valueIsObject) {
      output[key] = mergeDeep(current, value);
    } else if (currentIsObject || valueIsObject) {
      // A leaf cannot replace a namespace (or vice versa); keep the lower layer.
      continue;
    } else {
      output[key] = cloneValue(value);
    }
  }
  return output as T;
}

/** Resolves the caller-supplied project root against the invocation directory. */
function resolveProjectPath(cwd: string, projectPath: string): string {
  return resolve(cwd, projectPath);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `--config` wins, then `<projectPath>/unity-ci.yml`, then
 * `<projectPath>/unity.ci.yml`. An explicitly requested file that does not
 * exist is an issue; an absent default is not.
 */
function resolveConfigFile(
  projectPath: string,
  cwd: string,
  options: LoadConfigOptions,
  issues: ConfigIssue[],
): string | null {
  const requested = options.configFile ?? options.argv['config'];
  if (typeof requested === 'string' && requested !== '') {
    // An explicit path is relative to where the user typed it, not to the project.
    const path = resolve(cwd, requested);
    if (!isFile(path)) {
      issues.push({ path, message: `configuration file not found: ${path}` });
      return null;
    }
    return path;
  }
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(projectPath, name);
    if (isFile(path)) return path;
  }
  return null;
}

function collectLicenseSecrets(
  node: unknown,
  path: string,
  found: Array<{ path: string; message: string }>,
): void {
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const next = `${path}.${key}`;
    if (LICENSE_SECRET_KEYS.has(key.toLowerCase())) {
      found.push({
        path: next,
        message: `${next} is a secret: secrets travel through the environment or through git configuration only — never through a config file, a flag, or a command line`,
      });
      continue;
    }
    collectLicenseSecrets(value, next, found);
  }
}

/**
 * Scans the **whole parsed document** — every object key and every string value,
 * at any depth, including array entries — for a name that belongs in the
 * environment. A secret committed to `unity-ci.yml` is the leak GC5 exists to
 * prevent, and it is the one a user is most likely to create by accident; an
 * unknown key would otherwise be dropped silently by {@link mergeDeep}.
 *
 * `license.serialEnv`/`license.fileEnv` are the documented exception: their
 * value is *supposed* to be the variable name, so only keys are checked there.
 */
function collectSecretNames(
  node: unknown,
  path: string,
  found: ConfigIssue[],
): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => {
      const next = childPath(path, index);
      if (typeof entry === 'string' && isSecretEnvName(entry)) {
        found.push(secretValueIssue(next, entry));
        return;
      }
      collectSecretNames(entry, next, found);
    });
    return;
  }

  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const next = childPath(path, key);
    if (isSecretEnvName(key)) {
      found.push(secretKeyIssue(next, key));
      continue;
    }
    if (
      typeof value === 'string' &&
      isSecretEnvName(value) &&
      !SECRET_ENV_NAME_SETTINGS.has(next)
    ) {
      found.push(secretValueIssue(next, value));
      continue;
    }
    collectSecretNames(value, next, found);
  }
}

function readConfigFile(file: string, issues: ConfigIssue[]): DeepPartial<Config> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    issues.push({ path: file, message: `cannot read configuration file ${file}: ${describe(error)}` });
    return {};
  }

  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    issues.push({
      path: file,
      message: `cannot parse configuration file ${file}: ${describe(error)}`,
    });
    return {};
  }

  if (document === null || document === undefined) return {};
  if (!isPlainObject(document)) {
    issues.push({
      path: file,
      message: `configuration file ${file} must contain a YAML mapping at the top level`,
    });
    return {};
  }

  const licenseSecrets: ConfigIssue[] = [];
  collectLicenseSecrets(document['license'], 'license', licenseSecrets);

  // Whole-document scan: an environment-only name in *any* key or string value
  // is a configuration error, not an unknown key to drop.
  const secretNames: ConfigIssue[] = [];
  collectSecretNames(document, '', secretNames);

  const secrets = [...licenseSecrets, ...secretNames];
  issues.push(...secrets);

  // A license secret invalidates the license block; the other layers stay
  // usable. Any secret makes the caller exit 64, so the merge cannot leak it.
  return licenseSecrets.length === 0 ? (document as DeepPartial<Config>) : withoutLicense(document);
}

/** Drops `license` entirely when it contained a secret, keeping other layers usable. */
function withoutLicense(document: Record<string, unknown>): DeepPartial<Config> {
  const copy: Record<string, unknown> = { ...document };
  delete copy['license'];
  return copy as DeepPartial<Config>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The only flags that map to configuration keys; the rest are command input. */
function readFlagConfig(argv: ParseResult['flags']): DeepPartial<Config> {
  const output: DeepPartial<Config['output']> = {};
  let touched = false;

  const dir = argv['output-dir'];
  if (typeof dir === 'string') {
    output.dir = dir;
    touched = true;
  }

  const annotations = argv['annotations'];
  if (typeof annotations === 'string') {
    output.annotations = annotations as Config['output']['annotations'];
    touched = true;
  }

  const ci = argv['ci'];
  if (typeof ci === 'boolean') {
    output.ci = ci;
    touched = true;
  }

  return touched ? { output } : {};
}

/**
 * Exit code 6 may be retried at most once (two attempts): re-running an
 * identical broken configuration reproduces the failure, so a loop is never
 * useful. The cap is applied **here**, after validation, because
 * `validateConfig` is pure and must not modify the config it is given.
 */
function capCommandFailedRetries(config: Config): void {
  if (
    Array.isArray(config.retry.onExitCodes) &&
    config.retry.onExitCodes.includes(EXIT.COMMAND_FAILED) &&
    config.retry.maxAttempts > 2
  ) {
    config.retry.maxAttempts = 2;
  }
}

/**
 * Builds the effective configuration. Precedence is by **layer**, not by key:
 * defaults, then the config file, then the `UNITYCI_*` environment patch, then
 * the CLI flags — each deep-merged over the previous one.
 *
 * The config file is discovered at the **project root**, not at `cwd`: a run
 * against `--project-path examples/minimal-project` must honour that project's
 * own `unity-ci.yml`. `cwd` only resolves relative paths.
 *
 * A file that cannot be parsed is an issue, never a crash, and the defaults
 * are still returned. Validation issues are appended but never thrown; the
 * caller decides that a non-empty list means exit 64. The exit-code-6 retry cap
 * is the only repair, and it is applied after validation.
 */
export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const cwd = resolve(options.cwd);
  const projectPath = resolveProjectPath(cwd, options.projectPath);
  const issues: ConfigIssue[] = [];

  const configFile = resolveConfigFile(projectPath, cwd, options, issues);
  const fileLayer = configFile === null ? {} : readConfigFile(configFile, issues);
  const envLayer = readEnvConfig(options.env);
  const flagLayer = readFlagConfig(options.argv);

  let config = mergeDeep(DEFAULT_CONFIG, {});
  config = mergeDeep(config, fileLayer);
  config = mergeDeep(config, envLayer.patch);
  config = mergeDeep(config, flagLayer);

  issues.push(...validateConfig(config, projectPath));
  capCommandFailedRetries(config);

  return {
    config,
    issues,
    unknownEnvVars: envLayer.unknown,
    warnings: envLayer.warnings,
    projectPath,
  };
}
