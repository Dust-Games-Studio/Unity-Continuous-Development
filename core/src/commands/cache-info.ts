/**
 * `unityci cache-info`: describes the two caches worth carrying between runs —
 * the Editor **download** cache and the project `Library` — without touching a
 * cache service. The keys and paths are provider-neutral; restoring them is the
 * adapter's job (D7).
 *
 * A cache hint is an optimisation, never a gate. Every `unity` call here is
 * best-effort: a failed CLI call, a `success: false` envelope or an unparsable
 * document degrades to a fallback value with a warning and the command still
 * exits 0. Failing a green job because a cache key could not be computed is
 * worse than not caching.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { unityBaseOptions } from '../lifecycle/setup.js';
import { unityCacheInfo, unityCacheKey } from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';

/** The cache descriptors the spec's `cache-info --json` document exposes. */
export interface CacheInfo {
  editor: { paths: string[]; key: string };
  library: { paths: string[]; key: string; staticKey: string };
}

/** The output format is an argument: the CLI parses argv, not this module. */
export interface CacheInfoCommandOptions {
  /** Print the {@link CacheInfo} document as 2-space-indented JSON. */
  json?: boolean;
}

/**
 * The segment used for a version that cannot be resolved. An empty segment
 * would let two different Editors share one cache entry, which is worse than
 * telling the provider the cache is unknown.
 */
const UNKNOWN = 'unknown';

/** Logs without letting a broken sink turn a cache hint into a job failure. */
function safeLog(
  ctx: CoreContext,
  level: 'info' | 'warn',
  message: string,
): void {
  try {
    ctx.logger[level](message);
  } catch {
    // Deliberately swallowed: a cache hint must never fail a job.
  }
}

/** A description that never throws, for a rejected promise. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    try {
      return error.message;
    } catch {
      return 'unknown error';
    }
  }
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? '';
  return line.trim();
}

/**
 * One line describing a failed call, including Unity's own error code. The
 * envelope comes from unvalidated child output, so every field is guarded.
 */
function errorDetail(result: UnityResult): string {
  const raw: unknown = result.json?.errors;
  const errors = Array.isArray(raw) ? raw : [];
  const messages = errors
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return '';
      const error = entry as { code?: unknown; message?: unknown };
      const code = typeof error.code === 'string' ? error.code : '';
      const message = typeof error.message === 'string' ? error.message : '';
      if (code !== '' && message !== '') return `${code}: ${message}`;
      return message !== '' ? message : code;
    })
    .filter((message) => message !== '');

  const detail =
    messages[0] || firstLine(result.stderr) || firstLine(result.stdout);
  return detail === '' ? `exit ${result.code}` : `exit ${result.code}: ${detail}`;
}

/** The download-cache path from `unity cache info`, or null when unusable. */
function readDownloadPath(result: UnityResult): string | null {
  if (result.code !== 0 || result.json?.success === false) return null;
  const data = result.json?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const path = (data as { path?: unknown }).path;
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads a Library cache key from a `unity cache key` success document whose
 * shape has **not** been observed. The CLI's `--component` flag hints the real
 * key is composite, so all plausible shapes are accepted:
 *
 * - `data` is a string: use it;
 * - `data.key` is a non-empty string: use it;
 * - `data` carries only `editor`/`packages`/`target`: join them;
 * - anything else: null, so the caller falls back to the static key.
 */
function readCacheKey(data: unknown): string | null {
  if (typeof data === 'string') {
    const key = data.trim();
    return key === '' ? null : key;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const record = data as Record<string, unknown>;
  if (typeof record.key === 'string') {
    const key = record.key.trim();
    if (key !== '') return key;
  }

  const components = ['editor', 'packages', 'target'].map((name) => record[name]);
  const values = components.map((value) =>
    typeof value === 'string' ? value.trim() : '',
  );
  if (values.every((value) => value !== '')) return values.join('-');

  return null;
}

/**
 * The Editor version the cache keys use: the configured value, or the one
 * pinned in `ProjectSettings/ProjectVersion.txt` for `from-project`. Null when
 * neither yields a version — never an empty string.
 */
function resolveEditorVersion(ctx: CoreContext): string | null {
  const configured = ctx.config.unity.editor.version.trim();
  if (configured !== 'from-project') {
    return configured === '' ? null : configured;
  }
  try {
    const text = readFileSync(
      resolve(ctx.projectPath, 'ProjectSettings', 'ProjectVersion.txt'),
      'utf8',
    );
    const match = /^m_EditorVersion:\s*(\S+)/m.exec(text);
    const version = match?.[1]?.trim() ?? '';
    return version === '' ? null : version;
  } catch {
    // A missing or unreadable file is the same "unknown" case: the caller
    // reports a marker rather than an empty segment.
    return null;
  }
}

/**
 * Builds the two cache descriptors. It never throws and never returns an empty
 * key segment; every unavailable value is replaced by a documented fallback
 * (no editor path, or the static Library key) and logged as a warning.
 */
export async function cacheInfo(ctx: CoreContext): Promise<CacheInfo> {
  const base = unityBaseOptions(ctx);

  const editorVersion = resolveEditorVersion(ctx);
  if (editorVersion === null) {
    safeLog(
      ctx,
      'warn',
      'could not resolve the Unity Editor version (unity.editor.version is "from-project" and ProjectSettings/ProjectVersion.txt has no m_EditorVersion); cache keys use "unknown" rather than an empty segment.',
    );
  }
  const versionSegment = editorVersion ?? UNKNOWN;
  const configuredTarget = ctx.config.build.target.trim();
  const targetSegment = configuredTarget === '' ? UNKNOWN : configuredTarget;

  const staticKey = `unity-library-${versionSegment}-${targetSegment}`;

  // The download cache is authoritative only from the CLI. On failure the hint
  // carries no path at all rather than guessing a directory that may be wrong.
  let downloadPaths: string[] = [];
  try {
    const result = await unityCacheInfo(base);
    const path = readDownloadPath(result);
    if (path === null) {
      safeLog(
        ctx,
        'warn',
        `could not read the Unity download cache path from \`unity cache info\` (${errorDetail(result)}); the editor cache hint carries no path.`,
      );
    } else {
      downloadPaths = [path];
    }
  } catch (error) {
    safeLog(
      ctx,
      'warn',
      `could not run \`unity cache info\`: ${describe(error)}; the editor cache hint carries no path.`,
    );
  }

  // The Library key needs a real Unity project and is the only value here that
  // can fail for an ordinary reason (NOT_A_PROJECT, exit 11). The static key is
  // the documented fallback for exactly that case.
  let libraryKey: string | null = null;
  try {
    const result = await unityCacheKey(
      base,
      ctx.projectPath,
      configuredTarget === '' ? undefined : configuredTarget,
    );
    if (result.code !== 0 || result.json?.success === false) {
      safeLog(
        ctx,
        'warn',
        `could not compute the Library cache key from \`unity cache key\` (${errorDetail(result)}); using the static key ${staticKey}.`,
      );
    } else {
      libraryKey = readCacheKey(result.json?.data);
      if (libraryKey === null) {
        safeLog(
          ctx,
          'warn',
          `could not compute the Library cache key from \`unity cache key\`: the document has no usable key; using the static key ${staticKey}.`,
        );
      }
    }
  } catch (error) {
    safeLog(
      ctx,
      'warn',
      `could not run \`unity cache key\`: ${describe(error)}; using the static key ${staticKey}.`,
    );
  }

  return {
    editor: {
      paths: downloadPaths,
      key: `unity-downloads-${versionSegment}`,
    },
    library: {
      paths: [resolve(ctx.projectPath, 'Library')],
      key: libraryKey ?? staticKey,
      staticKey,
    },
  };
}

/**
 * `unityci cache-info`: prints the cache descriptors and always exits 0.
 *
 * `--json` (passed by the CLI) emits the {@link CacheInfo} object as
 * 2-space-indented JSON with a trailing newline so a provider can pipe it;
 * otherwise a short labelled summary goes to the log.
 */
export async function cacheInfoCommand(
  ctx: CoreContext,
  opts: CacheInfoCommandOptions = {},
): Promise<number> {
  const info = await cacheInfo(ctx);

  if (opts.json === true) {
    safeLog(ctx, 'info', JSON.stringify(info, null, 2));
    return EXIT.SUCCESS;
  }

  const editorPaths =
    info.editor.paths.length === 0
      ? 'not reported by `unity cache info`'
      : info.editor.paths.join(', ');
  safeLog(ctx, 'info', `editor cache: ${editorPaths} (key ${info.editor.key})`);
  safeLog(
    ctx,
    'info',
    `library cache: ${info.library.paths.join(', ')} (key ${info.library.key})`,
  );
  safeLog(ctx, 'info', `static library cache key: ${info.library.staticKey}`);
  return EXIT.SUCCESS;
}
