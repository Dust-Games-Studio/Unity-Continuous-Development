import type { Logger } from '../logger.js';
import type { Redactor } from '../redact.js';
import { runUnity, type UnityResult } from './exec.js';

/**
 * The Unity CLI releases this toolkit is tested against. A CLI below the floor
 * fails the preflight; one above the ceiling is a loud warning, not a failure
 * (R13).
 */
export const TESTED_CLI_MIN = '1.0.0-beta.9';
export const TESTED_CLI_MAX = '1.0.0-beta.14';

/**
 * Everything a wrapper needs to start one Unity invocation.
 *
 * `cwd` is the directory the child process runs in. A project path is always
 * passed positionally to the Unity verb (`unity cache key <project>`), never
 * folded into `cwd` and never implied by it.
 */
export interface UnityBaseOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  redactor: Redactor;
  timeoutMs?: number;
}

export interface UnityInstallOptions {
  version: string;
  /**
   * Module IDs installed alongside the Editor. They are the lowercase ids from
   * `unity install --list-modules` (`android`, `ios`, `webgl`, `linux-il2cpp`,
   * `linux-mono`, `linux-server`, `mac-mono`,
   * `universal-windows-platform`, …).
   */
  modules?: string[];
  /** `true` sends `--cm`, `false` sends `--no-cm`, unset sends neither. */
  childModules?: boolean;
  /** Required only for versions that are not in Unity's release list. */
  changeset?: string;
  /** `x86_64` or `arm64`. */
  architecture?: string;
  /** Accepts Unity's and every selected module's licence agreements. */
  acceptEula?: boolean;
  /** Defaults to true: the toolkit never wants an interactive install. */
  yes?: boolean;
}

function run(opts: UnityBaseOptions, args: string[]): Promise<UnityResult> {
  return runUnity({
    binary: opts.binary,
    args,
    cwd: opts.cwd,
    env: opts.env,
    logger: opts.logger,
    redactor: opts.redactor,
    timeoutMs: opts.timeoutMs,
  });
}

/** `unity version --format json`: the CLI's own identity, never `--version`. */
export function unityVersion(opts: UnityBaseOptions): Promise<UnityResult> {
  return run(opts, ['version', '--format', 'json']);
}

/** `unity doctor --ci --format json`: the machine-readable preflight report. */
export function unityDoctorCi(opts: UnityBaseOptions): Promise<UnityResult> {
  return run(opts, ['doctor', '--ci', '--format', 'json']);
}

/** `unity install <version> [--module <ids…>] [--cm|--no-cm] …` */
export function unityInstall(
  opts: UnityBaseOptions,
  install: UnityInstallOptions,
): Promise<UnityResult> {
  const args = ['install', install.version];

  if (install.modules && install.modules.length > 0) {
    // `--module` is variadic (`<module...>`): one flag, every module id.
    args.push('--module', ...install.modules);
  }
  if (install.childModules === true) args.push('--cm');
  else if (install.childModules === false) args.push('--no-cm');
  if (install.changeset) args.push('--changeset', install.changeset);
  if (install.architecture) args.push('--architecture', install.architecture);
  if (install.yes !== false) args.push('--yes');
  if (install.acceptEula) args.push('--accept-eula');

  args.push('--format', 'json');
  return run(opts, args);
}

/** `unity terms accept <version> --yes --format json` (R10). */
export function unityTermsAccept(
  opts: UnityBaseOptions,
  version: string,
): Promise<UnityResult> {
  return run(opts, ['terms', 'accept', version, '--yes', '--format', 'json']);
}

/** `unity license status --format json`: `data.active` is the precondition. */
export function unityLicenseStatus(opts: UnityBaseOptions): Promise<UnityResult> {
  return run(opts, ['license', 'status', '--format', 'json']);
}

/** `unity license activate <args…> --format json`. Secrets stay in `env`. */
export function unityLicenseActivate(
  opts: UnityBaseOptions,
  args: string[],
): Promise<UnityResult> {
  return run(opts, ['license', 'activate', ...args, '--format', 'json']);
}

/** `unity license return --yes --format json`: the teardown step. */
export function unityLicenseReturn(opts: UnityBaseOptions): Promise<UnityResult> {
  return run(opts, ['license', 'return', '--yes', '--format', 'json']);
}

/**
 * `unity test <args…> --format json`. The caller owns mode selection; a project
 * path, when given, is one of the positional `args`.
 */
export function unityTest(opts: UnityBaseOptions, args: string[]): Promise<UnityResult> {
  return run(opts, ['test', ...args, '--format', 'json']);
}

/**
 * `unity build <args…> --format json`. A project path, when given, is one of the
 * positional `args`.
 */
export function unityBuild(opts: UnityBaseOptions, args: string[]): Promise<UnityResult> {
  return run(opts, ['build', ...args, '--format', 'json']);
}

/**
 * `unity cache key <projectPath> [--target <target>] --format json`. The
 * project path is positional; `opts.cwd` only sets where the child runs.
 */
export function unityCacheKey(
  opts: UnityBaseOptions,
  projectPath: string,
  target?: string,
): Promise<UnityResult> {
  const args = ['cache', 'key', projectPath];
  if (target) args.push('--target', target);
  args.push('--format', 'json');
  return run(opts, args);
}

/** `unity cache info --format json`: the download-cache descriptor. */
export function unityCacheInfo(opts: UnityBaseOptions): Promise<UnityResult> {
  return run(opts, ['cache', 'info', '--format', 'json']);
}

/**
 * `unity projects verify <projectPath> --strict --format json`. The project
 * path is positional; `opts.cwd` only sets where the child runs.
 */
export function unityProjectsVerify(
  opts: UnityBaseOptions,
  projectPath: string,
): Promise<UnityResult> {
  return run(opts, ['projects', 'verify', projectPath, '--strict', '--format', 'json']);
}

/**
 * `unity editors --installed --format json`: which Editors are present.
 *
 * Each row's `modules` string holds **display names** (`"Linux"`,
 * `"Android, Android SDK & NDK Tools, …"`), not the lowercase module ids. It is
 * reported here but must never be compared against ids: the authoritative
 * per-module answer is `unityModulesList` and its `isInstalled` boolean. `""`
 * is a valid installed Editor that carries no platform modules.
 */
export function unityEditorsInstalled(opts: UnityBaseOptions): Promise<UnityResult> {
  return run(opts, ['editors', '--installed', '--format', 'json']);
}

/**
 * `unity install <version> --list-modules --format json`: the authoritative
 * answer to "is module X installed for editor V".
 *
 * Each row carries the lowercase module id, its display `name`, `status`,
 * `aliases` and the `isInstalled` boolean. The `modules` string on an
 * `editors --installed` row is a different namespace (display names such as
 * `"Android, Android SDK & NDK Tools, Linux"`), so it must never be compared
 * against the ids in `unity.editor.modules`.
 */
export function unityModulesList(
  opts: UnityBaseOptions,
  version: string,
): Promise<UnityResult> {
  return run(opts, ['install', version, '--list-modules', '--format', 'json']);
}

/** Error codes a CLI uses when the verb (or one of its words) does not exist. */
const UNSUPPORTED_COMMAND_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_COMMAND',
  'UNSUPPORTED_COMMAND',
  'COMMAND_NOT_FOUND',
  'NO_SUCH_COMMAND',
]);

/**
 * Matches the CLI's own wording for a missing verb, e.g. `unknown command
 * 'doctor'` or `command 'projects' is not supported`.
 *
 * Deliberately narrow: an *option* error (`unknown option --foo`) is a
 * different problem, and a compile or licence failure must never be reported
 * as an unsupported command.
 */
const UNSUPPORTED_COMMAND_MESSAGE =
  /\b(?:unknown|unsupported|unrecognized|unrecognised)\s+(?:command|subcommand)\b(?=\s*(?:[:("'`]|$))|\bcommand\s+["'`]?[\w:.-]+["'`]?\s+(?:is\s+)?not\s+(?:found|supported|recognized|recognised)\b|\bdoes\s+not\s+support\s+(?:the\s+)?["'`]?[\w:.-]+["'`]?\s+command\b/i;

/**
 * True when a failed `unity` call means "this CLI does not know the command".
 *
 * The core probes this instead of gating on a version string: beta releases add
 * and rename commands between fortnightly drops, and a clear "this Unity CLI
 * does not support X" beats a crash or a generic exit 6 (R13).
 */
export function isUnsupportedCommand(result: UnityResult): boolean {
  if (result.code === 0) return false;

  for (const error of result.json?.errors ?? []) {
    const code = (error.code ?? '').toUpperCase();
    if (
      UNSUPPORTED_COMMAND_CODES.has(code) ||
      code.includes('UNKNOWN_COMMAND') ||
      code.includes('UNSUPPORTED_COMMAND')
    ) {
      return true;
    }
    if (UNSUPPORTED_COMMAND_MESSAGE.test(error.message ?? '')) return true;
  }

  return (
    UNSUPPORTED_COMMAND_MESSAGE.test(result.stderr) ||
    UNSUPPORTED_COMMAND_MESSAGE.test(result.stdout)
  );
}
