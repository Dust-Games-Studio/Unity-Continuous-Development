import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
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

export interface LoadConfigOptions {
  /** Where `unity-ci.yml` is looked up, and what relative paths resolve against. */
  cwd: string;
  /** The already-parsed flags; `loadConfig` never re-parses argv. */
  argv: Record<string, string | boolean | string[]>;
  env: NodeJS.ProcessEnv;
  /** An explicit config file (the caller's resolved `--config`), if any. */
  configFile?: string;
}

export interface LoadConfigResult {
  config: Config;
  issues: ConfigIssue[];
  unknownEnvVars: string[];
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

/** The project root paths must resolve inside: `--project-path`, else `cwd`. */
function projectRoot(cwd: string, argv: LoadConfigOptions['argv']): string {
  const flag = argv['project-path'];
  return typeof flag === 'string' && flag !== '' ? resolve(cwd, flag) : cwd;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * `--config` wins, then `unity-ci.yml`, then `unity.ci.yml`. An explicitly
 * requested file that does not exist is an issue; an absent default is not.
 */
function resolveConfigFile(
  cwd: string,
  options: LoadConfigOptions,
  issues: ConfigIssue[],
): string | null {
  const requested = options.configFile ?? options.argv['config'];
  if (typeof requested === 'string' && requested !== '') {
    const path = resolve(cwd, requested);
    if (!isFile(path)) {
      issues.push({ path, message: `configuration file not found: ${path}` });
      return null;
    }
    return path;
  }
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(cwd, name);
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

  const secrets: ConfigIssue[] = [];
  collectLicenseSecrets(document['license'], 'license', secrets);
  issues.push(...secrets);

  // A file that carries a secret is never honoured: only the non-secret keys
  // survive, and the caller's exit 64 makes the omission irrelevant.
  return secrets.length === 0 ? (document as DeepPartial<Config>) : withoutLicense(document);
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
function readFlagConfig(argv: LoadConfigOptions['argv']): DeepPartial<Config> {
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
 * Builds the effective configuration. Precedence is by **layer**, not by key:
 * defaults, then the config file, then the `UNITYCI_*` environment patch, then
 * the CLI flags — each deep-merged over the previous one.
 *
 * A file that cannot be parsed is an issue, never a crash, and the defaults
 * are still returned. Validation issues are appended but never thrown; the
 * caller decides that a non-empty list means exit 64.
 */
export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const cwd = resolve(options.cwd);
  const root = projectRoot(cwd, options.argv);
  const issues: ConfigIssue[] = [];

  const configFile = resolveConfigFile(cwd, options, issues);
  const fileLayer = configFile === null ? {} : readConfigFile(configFile, issues);
  const envLayer = readEnvConfig(options.env);
  const flagLayer = readFlagConfig(options.argv);

  let config = mergeDeep(DEFAULT_CONFIG, {});
  config = mergeDeep(config, fileLayer);
  config = mergeDeep(config, envLayer.patch);
  config = mergeDeep(config, flagLayer);

  issues.push(...validateConfig(config, root));

  return { config, issues, unknownEnvVars: envLayer.unknown };
}
