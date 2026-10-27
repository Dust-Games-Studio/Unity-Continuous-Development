import { DEFAULT_CONFIG, type Config } from './schema.js';

/**
 * Every `UNITYCI_*` environment variable the toolkit understands, mapped to
 * its dotted configuration path (GC14's middle precedence layer).
 */
export const ENV_KEYS: Record<string, string> = {
  UNITYCI_CLI_VERSION: 'unity.cli.version',
  UNITYCI_CLI_ALLOW_LATEST: 'unity.cli.allowLatest',
  UNITYCI_UNITY_BINARY: 'unity.cli.binary',
  UNITYCI_EDITOR_VERSION: 'unity.editor.version',
  UNITYCI_EDITOR_MODULES: 'unity.editor.modules',
  UNITYCI_EDITOR_CHANGESET: 'unity.editor.changeset',
  UNITYCI_EDITOR_ACCEPT_EULA: 'unity.editor.acceptEula',
  UNITYCI_EDITOR_TERMS: 'unity.editor.terms',
  UNITYCI_LICENSE_MODE: 'license.mode',
  UNITYCI_TEST_MODES: 'test.modes',
  UNITYCI_TEST_FILTER: 'test.filter',
  UNITYCI_TEST_COVERAGE: 'test.coverage',
  UNITYCI_TEST_NOGRAPHICS: 'test.nographics',
  UNITYCI_TEST_SHARDS: 'test.shards',
  UNITYCI_BUILD_TARGET: 'build.target',
  UNITYCI_BUILD_PROFILE: 'build.profile',
  UNITYCI_BUILD_METHOD: 'build.executeMethod',
  UNITYCI_RETRY_EXIT_CODES: 'retry.onExitCodes',
  UNITYCI_RETRY_MAX_ATTEMPTS: 'retry.maxAttempts',
  UNITYCI_OUTPUT_DIR: 'output.dir',
  UNITYCI_ANNOTATIONS: 'output.annotations',
  UNITYCI_CI: 'output.ci',
  UNITYCI_PACKAGES_PREFLIGHT: 'packages.preflight',
  UNITYCI_DOCTOR_MIN_FREE_BYTES: 'doctor.minFreeBytes',
};

/**
 * A deep patch: a shallow `Partial<Config>` cannot express `unity.cli.version`
 * without also supplying every sibling of `unity` and `cli`.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Paths that parse a comma-separated list rather than a single scalar. */
const LIST_PATHS: ReadonlyMap<string, 'string' | 'number'> = new Map([
  ['unity.editor.modules', 'string'],
  ['test.modes', 'string'],
  ['retry.onExitCodes', 'number'],
]);

/** Nullable strings: an empty value clears them, matching the file's `null`. */
const NULLABLE_PATHS: ReadonlySet<string> = new Set([
  'unity.editor.changeset',
  'test.filter',
  'test.shards',
  'build.profile',
  'build.executeMethod',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(source: unknown, path: string): unknown {
  let node = source;
  for (const part of path.split('.')) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setAt(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (isPlainObject(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[part] = created;
      node = created;
    }
  }
  const last = parts[parts.length - 1];
  if (last !== undefined) node[last] = value;
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseList(raw: string, item: 'string' | 'number'): Parsed {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (item === 'string') return { ok: true, value: parts };
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isInteger(number))) return { ok: false };
  return { ok: true, value: numbers };
}

function parseValue(path: string, raw: string): Parsed {
  const listItem = LIST_PATHS.get(path);
  if (listItem !== undefined) return parseList(raw, listItem);

  if (NULLABLE_PATHS.has(path)) return { ok: true, value: raw === '' ? null : raw };

  const fallback = valueAt(DEFAULT_CONFIG, path);
  if (typeof fallback === 'boolean') {
    const normalised = raw.trim().toLowerCase();
    if (normalised === 'true') return { ok: true, value: true };
    if (normalised === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  if (typeof fallback === 'number') {
    const number = Number(raw);
    return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
  }
  return { ok: true, value: raw };
}

/**
 * Reads the `UNITYCI_*` environment layer. The patch is deep, so
 * `UNITYCI_CLI_VERSION` sets `unity.cli.version` without disturbing
 * `unity.cli.allowLatest` or `unity.cli.binary`.
 *
 * The result separates the two warning conditions, because they mean different
 * things to the user:
 * - `unknown` lists every `UNITYCI_*` variable whose name is not in
 *   `ENV_KEYS` (and is not `UNITYCI_SECRET_*`) — a typo or a variable from
 *   another tool; the value is ignored.
 * - `warnings` lists every variable that **is** known but whose value could not
 *   be parsed (a non-boolean where a boolean is expected, a non-integer where a
 *   number is expected); the value is ignored and the lower layer stands.
 *
 * Neither is a failure: an environment typo must not fail a whole CI job.
 * Values under `UNITYCI_SECRET_*` are read by the lifecycle code directly and
 * are deliberately never part of the configuration, so they are not "unknown".
 */
export function readEnvConfig(env: NodeJS.ProcessEnv): {
  patch: DeepPartial<Config>;
  unknown: string[];
  warnings: string[];
} {
  const patch: Record<string, unknown> = {};
  const unknown: string[] = [];
  const warnings: string[] = [];

  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith('UNITYCI_')) continue;
    if (name.startsWith('UNITYCI_SECRET_')) continue;
    const path = ENV_KEYS[name];
    if (path === undefined) {
      unknown.push(name);
      continue;
    }
    if (raw === undefined) continue;
    const parsed = parseValue(path, raw);
    if (!parsed.ok) {
      warnings.push(name);
      continue;
    }
    setAt(patch, path, parsed.value);
  }

  unknown.sort();
  warnings.sort();
  return { patch: patch as DeepPartial<Config>, unknown, warnings };
}
