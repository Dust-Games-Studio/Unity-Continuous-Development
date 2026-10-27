import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A package dependency whose source is a git repository. */
export interface GitDependency {
  /** The package name (the key in `Packages/manifest.json`). */
  name: string;
  /** The URL exactly as the project declares it. */
  url: string;
  /** The repository host, e.g. `github.com`. */
  host: string;
  /**
   * True when the URL itself carries a credential. Unity copies the URL
   * verbatim into the committed `Packages/packages-lock.json`, so such a
   * project is refused (GC21).
   */
  hasEmbeddedCredentials: boolean;
}

/** A URL scheme git understands, plus the scp-like `user@host:path` form. */
const GIT_URL_PREFIX = /^(?:https?|ssh|git):\/\/|^[^@\s]+@[^:\s]+:/i;

/** Any `scheme://` URL. */
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Strips the query string and fragment Unity appends to git URLs
 * (`…/repo.git?path=/sub#v1.0.0`), leaving the URL colour for `.git`.
 */
function withoutSuffix(url: string): string {
  const hash = url.indexOf('#');
  const beforeHash = hash === -1 ? url : url.slice(0, hash);
  const query = beforeHash.indexOf('?');
  return query === -1 ? beforeHash : beforeHash.slice(0, query);
}

/**
 * A dependency is git-hosted when its value is a git URL: `https://….git`,
 * `git@host:owner/repo.git`, `ssh://…` or `git://…`.
 *
 * A registry dependency is not: `com.unity.ugui` is a version range, and a
 * scoped registry (`https://packages.unity.com/…`) has no `.git` suffix.
 */
export function isGitDependencyUrl(value: string): boolean {
  if (!GIT_URL_PREFIX.test(value)) return false;
  // `ssh://` and `git://` are unambiguous git transports; a `.git` suffix is
  // conventional, not required.
  if (/^(?:ssh|git):\/\//i.test(value)) return true;
  return /\.git$/i.test(withoutSuffix(value));
}

/** The repository hostname, without any userinfo or port. */
export function gitDependencyHost(url: string): string {
  if (SCHEME_URL.test(url)) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }
  // scp-like syntax: `user@host:owner/repo.git`
  const match = url.match(/^[^@\s]+@([^:\s/]+):/);
  return match?.[1] ?? '';
}

/**
 * True when the URL carries a secret in its userinfo component.
 *
 * `https://user:token@host/repo.git` and `https://token@host/repo.git` do.
 * `ssh://git@host/repo.git` and `git@host:owner/repo.git` do not: `git` there
 * is the SSH account, part of the URL's syntax, not a credential. A password
 * on any scheme is always a credential.
 */
export function hasEmbeddedCredentials(url: string): boolean {
  if (!SCHEME_URL.test(url)) {
    // The scp-like form has no password field, so it cannot embed a secret.
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.password !== '') return true;
  // An HTTP(S) username is a token; an SSH username is an account name.
  return /^https?:$/i.test(parsed.protocol) && parsed.username !== '';
}

/**
 * Masks userinfo so a refusal message can name the package and the host
 * without echoing the credential into a log or a report (GC21).
 */
export function redactGitUrl(url: string): string {
  if (!SCHEME_URL.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    return `${parsed.protocol}//***@${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url.replace(/^([^@\s]+)@/, '***@');
  }
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function readJsonObject(path: string): JsonObject | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${(error as Error).message}`);
  }
  const object = asObject(parsed);
  if (object === null) throw new Error(`cannot parse ${path}: expected a JSON object`);
  return object;
}

/**
 * Reads the project's git-hosted package dependencies.
 *
 * `Packages/manifest.json` is the declared set; `Packages/packages-lock.json`
 * contributes the resolved set (which can include a transitive git dependency)
 * and never overrides a manifest entry. A project with no manifest has no
 * dependencies this toolkit can preflight, so the list is empty.
 */
export function readGitDependencies(projectPath: string): GitDependency[] {
  const manifest = readJsonObject(join(projectPath, 'Packages', 'manifest.json'));
  if (manifest === null) return [];

  const declared = new Map<string, string>();
  const manifestDeps = asObject(manifest.dependencies);
  if (manifestDeps !== null) {
    for (const [name, value] of Object.entries(manifestDeps)) {
      if (typeof value === 'string') declared.set(name, value);
    }
  }

  const lock = readJsonObject(join(projectPath, 'Packages', 'packages-lock.json'));
  const lockDeps = asObject(lock?.dependencies);
  if (lockDeps !== null) {
    for (const [name, raw] of Object.entries(lockDeps)) {
      // The manifest is the source of truth for a declared package.
      if (declared.has(name)) continue;
      const entry = asObject(raw);
      if (entry === null) continue;
      const version = typeof entry.version === 'string' ? entry.version : null;
      if (version !== null && isGitDependencyUrl(version)) {
        declared.set(name, version);
      }
    }
  }

  const dependencies: GitDependency[] = [];
  for (const [name, url] of declared) {
    if (!isGitDependencyUrl(url)) continue;
    dependencies.push({
      name,
      url,
      host: gitDependencyHost(url),
      hasEmbeddedCredentials: hasEmbeddedCredentials(url),
    });
  }
  return dependencies;
}
