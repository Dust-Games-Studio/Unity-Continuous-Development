import { spawnProcess } from '../exec.js';
import type { Logger } from '../logger.js';
import type { Redactor } from '../redact.js';
import type { GitDependency } from './deps.js';

export interface GitPreflightResult {
  dependency: GitDependency;
  reachable: boolean;
  detail: string;
}

export interface GitPreflightOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  redactor: Redactor;
  /**
   * A private host that is slow to answer must not stall the preflight forever.
   * Defaults to 30 seconds per unique repository.
   */
  timeoutMs?: number;
}

/** How long a single `git ls-remote` may take before the child is killed. */
const DEFAULT_TIMEOUT_MS = 30_000;

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? '';
  return line.trim();
}

/**
 * Proves one repository is fetchable with the same ambient git configuration
 * the Unity Package Manager will use.
 *
 * The URL is passed as one argv token and never through a shell, so a hostile
 * URL cannot become a command. No credential is added: a URL rewrite in
 * `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` or the per-invocation
 * `GIT_CONFIG_*` variables is the adapter's job (GC22). `GIT_CONFIG_GLOBAL` is
 * deliberately not set or consulted by name: Unity's Package Manager ignores
 * it (see `docs/decisions/upm-git-auth-probe.md`).
 */
async function probe(
  url: string,
  opts: GitPreflightOptions,
): Promise<{ reachable: boolean; detail: string }> {
  const result = await spawnProcess({
    file: 'git',
    args: ['ls-remote', '--exit-code', url],
    cwd: opts.cwd,
    // Ambient environment (HOME, SSH_AUTH_SOCK, GIT_CONFIG_* …) plus the
    // caller's additions: that is the configuration the Package Manager sees.
    env: { ...process.env, ...opts.env },
    logger: opts.logger,
    redactor: opts.redactor,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (result.code === 0) {
    return { reachable: true, detail: 'git ls-remote succeeded' };
  }

  const stderr = firstLine(result.stderr);
  return {
    reachable: false,
    detail:
      `git ls-remote exited ${result.code}` + (stderr === '' ? '' : `: ${stderr}`),
  };
}

/**
 * Runs `git ls-remote --exit-code <url>` once per **unique repository URL** —
 * two packages can come from one repository — and returns one result per
 * dependency, in input order.
 *
 * A URL that embeds credentials is never handed to a child process: `setup`
 * refuses it before this function is reached, and this function refuses it
 * again as a last line of defence.
 */
export async function preflightGitDependencies(
  deps: GitDependency[],
  opts: GitPreflightOptions,
): Promise<GitPreflightResult[]> {
  const urls = [
    ...new Set(
      deps.filter((dependency) => !dependency.hasEmbeddedCredentials).map((dependency) => dependency.url),
    ),
  ];

  const uniqueResults = await Promise.all(urls.map((url) => probe(url, opts)));
  const byUrl = new Map(urls.map((url, index) => [url, uniqueResults[index]!]));

  return deps.map((dependency) => {
    if (dependency.hasEmbeddedCredentials) {
      return {
        dependency,
        reachable: false,
        detail: 'refused: the URL embeds credentials and was not contacted',
      };
    }
    const outcome = byUrl.get(dependency.url);
    return {
      dependency,
      reachable: outcome?.reachable ?? false,
      detail: outcome?.detail ?? 'not probed',
    };
  });
}
