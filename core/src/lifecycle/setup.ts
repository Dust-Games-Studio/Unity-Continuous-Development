import { readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import type { GitDependency } from '../packages/deps.js';
import { readGitDependencies, redactGitUrl } from '../packages/deps.js';
import { preflightGitDependencies } from '../packages/git.js';
import {
  hostPlatform,
  isBuildTargetSupportedOnHost,
  modulesForBuildTarget,
  modulesForTestMode,
  type HostPlatform,
} from '../packages/modules.js';
import type { Redactor } from '../redact.js';
import {
  TESTED_CLI_MAX,
  TESTED_CLI_MIN,
  isUnsupportedCommand,
  unityEditorsInstalled,
  unityInstall,
  unityLicenseStatus,
  unityModulesList,
  unityTermsAccept,
  unityVersion,
  type UnityBaseOptions,
} from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';
import { listingRows } from '../unity/listings.js';

/** A precondition failure: the caller prints the message and exits `exitCode`. */
export class SetupError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.CONFIG_ERROR) {
    super(message);
    this.name = 'SetupError';
    this.exitCode = exitCode;
  }
}

export interface SetupResult {
  editorVersion: string;
  cliVersion: string;
  cliChannel: string | null;
  cliCommit: string | null;
  /** True when this run installed the Editor or a missing module. */
  installed: boolean;
  /**
   * Retained for the shared result shape. `setup` no longer runs
   * `unity doctor --ci` (the run path calls `doctor` separately), so this is
   * always `'unknown'`.
   */
  doctorVerdict: 'pass' | 'fail' | 'unknown';
}

/**
 * Which command is invoking setup. The module requirement belongs to the
 * command, not to the project: a build needs its target's modules, a test needs
 * none, and a command with no requirement checks only the Editor version.
 */
export interface SetupOptions {
  command?: 'build' | 'test';
  /**
   * The build target to derive the module requirement from. `undefined` (the
   * default) uses `config.build.target`; `null` says "no target is known" — a
   * profile-only build — which skips the target-driven module check and warns,
   * rather than silently skipping it the way an empty string once did.
   */
  target?: string | null;
  /**
   * An explicit, non-empty override. When present the config-derived list is
   * ignored, so a caller that knows better (or a future command) can state its
   * modules. An empty array means "no override", never "disable the check".
   */
  requiredModules?: string[];
  /**
   * The host whose build-support modules are required. Defaults to
   * `hostPlatform()`; injectable so cross-build behaviour is testable.
   */
  host?: HostPlatform;
}

/**
 * Backwards-compatible call shape: a plain array is the explicit override.
 * `setup(ctx)` remains the version-only check. Note: `[]` is treated
 * as no override (M7), so it cannot silently disable a build's module check.
 */
export type SetupInput = SetupOptions | string[];

/** A row of the toolkit's own doctor output. */
export interface PreflightCheck {
  id: string;
  status: string;
  code: string;
  blocking: boolean;
  message: string;
  source: 'unity' | 'core';
}

/** Unity's CLI requires this glibc floor on Linux. */
export const GLIBC_FLOOR = '2.34';

/** One row of `unity doctor --ci --format json`'s `data.checks[]`. */
export interface UnityDoctorCheck {
  id: string;
  status: string;
  code: string;
  blocking: boolean;
  message: string;
}

export interface UnityDoctorEvaluation {
  verdict: 'pass' | 'fail' | 'unknown';
  checks: UnityDoctorCheck[];
  /** False when stdout did not carry a machine-readable doctor report. */
  reportOk: boolean;
}

/** The same allow-list the config validator uses (GC15). */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(object: JsonObject | null, name: string): string | null {
  const value = object?.[name];
  return typeof value === 'string' ? value : null;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? '';
  return line.trim();
}

function resultDetail(result: UnityResult): string {
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return detail === '' ? '' : `: ${detail}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The base options for every Unity child started by `setup`/`doctor`.
 *
 * The two CI-only environment variables come from here, not from `runUnity`:
 * this layer knows `output.ci`, and `runUnity` must not know about the config
 * (GC13).
 */
export function unityBaseOptions(ctx: CoreContext): UnityBaseOptions {
  const env: NodeJS.ProcessEnv = { ...ctx.env };
  if (ctx.config.output.ci) {
    env.UNITY_NO_CRASH_REPORT = '1';
    env.UNITY_NO_CONSENT_PROMPT = '1';
  }
  // 1.0.x makes these ambient variables steer build/test ('build' and 'test'
  // read them; the flag still wins). The project's own version and the
  // toolkit's architecture must be the only source, so an operator's exported
  // value cannot silently change which Editor a pipeline uses.
  delete env.UNITY_EDITOR_VERSION;
  delete env.UNITY_ARCHITECTURE;
  const architecture = ctx.config.unity.editor.architecture;
  if (architecture !== null) env.UNITY_ARCHITECTURE = architecture;
  return {
    binary: ctx.binary,
    // Doctor/verify act on the project passed to the command, so the child's
    // working directory is the project root (a wrapper with a project argument
    // still passes it positionally).
    cwd: ctx.projectPath,
    env,
    logger: ctx.logger,
    redactor: ctx.redactor,
  };
}

// --- CLI identity ---------------------------------------------------------------

interface ParsedCliVersion {
  core: [number, number, number];
  channel: string | null;
  channelNumber: number | null;
}

/**
 * A deliberately small, semver-ish parser: the tested range is `1.0.0`
 * through `1.0.x` with no channel suffix today, but a `-channel.N` prerelease
 * still has to compare correctly for a CLI that predates the stable floor.
 * Build metadata is ignored.
 */
function parseCliVersion(version: string): ParsedCliVersion | null {
  const withoutBuild = version.split('+', 1)[0] ?? version;
  const match = withoutBuild.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z][A-Za-z0-9]*)(?:\.(\d+))?)?$/,
  );
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    channel: match[4] ?? null,
    channelNumber: match[5] === undefined ? null : Number(match[5]),
  };
}

function compareCliVersions(a: string, b: string): number | null {
  const left = parseCliVersion(a);
  const right = parseCliVersion(b);
  if (left === null || right === null) return null;

  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }

  // A release is newer than any pre-release of the same core version.
  if (left.channel === null && right.channel === null) return 0;
  if (left.channel === null) return 1;
  if (right.channel === null) return -1;
  if (left.channel !== right.channel) {
    return left.channel < right.channel ? -1 : 1;
  }
  const leftNumber = left.channelNumber ?? 0;
  const rightNumber = right.channelNumber ?? 0;
  return leftNumber - rightNumber;
}

/** Where a running CLI sits relative to the range this toolkit is tested on. */
export function cliVersionStatus(
  version: string,
): 'below' | 'inside' | 'above' | 'unknown' {
  const belowFloor = compareCliVersions(version, TESTED_CLI_MIN);
  const aboveCeiling = compareCliVersions(version, TESTED_CLI_MAX);
  if (belowFloor === null || aboveCeiling === null) return 'unknown';
  if (belowFloor < 0) return 'below';
  if (aboveCeiling > 0) return 'above';
  return 'inside';
}

export interface ResolveCliIdentityOptions {
  /**
   * `true` (the default) keeps the gate fatal below the tested floor. `doctor`
   * passes `false` so it can record the finding as a blocking check and still
   * write its report.
   */
  throwBelowFloor?: boolean;
}

/**
 * Reads `unity version --format json` — never `unity --version`, which
 * self-reported a different build on the spike machine — records the identity
 * on the context, and applies GC17: below the tested floor is exit 64, above
 * the ceiling is a warning.
 */
export async function resolveCliIdentity(
  ctx: CoreContext,
  options: ResolveCliIdentityOptions = {},
): Promise<{ version: string; channel: string | null; commit: string | null }> {
  const result = await unityVersion(unityBaseOptions(ctx));
  if (isUnsupportedCommand(result)) {
    throw new SetupError(
      'this Unity CLI does not support `version`; the toolkit cannot record which CLI build is running.',
      EXIT.CONFIG_ERROR,
    );
  }
  const data = asObject(result.json?.data);
  const version = stringField(data, 'version');

  if (result.code !== 0 || version === null) {
    throw new SetupError(
      `could not read the Unity CLI identity from \`unity version --format json\` (exit ${result.code})${resultDetail(result)}`,
      result.code !== 0 ? result.code : EXIT.CONFIG_ERROR,
    );
  }

  const channel = stringField(data, 'channel');
  const commit = stringField(data, 'commit');
  ctx.cliVersion = version;
  ctx.cliChannel = channel;
  ctx.cliCommit = commit;

  const status = cliVersionStatus(version);
  if (status === 'unknown') {
    ctx.logger.warn(
      `Unity CLI version ${version} is not comparable to the tested range ${TESTED_CLI_MIN}..${TESTED_CLI_MAX}; continuing without a version verdict.`,
    );
  } else if (status === 'below' && options.throwBelowFloor !== false) {
    throw new SetupError(
      `Unity CLI ${version} is older than the tested floor ${TESTED_CLI_MIN}; upgrade the Unity CLI before running this pipeline.`,
      EXIT.CONFIG_ERROR,
    );
  } else if (status === 'above') {
    ctx.logger.warn(
      `Unity CLI ${version} is newer than the tested ceiling ${TESTED_CLI_MAX}; continuing, but this build's behaviour is unverified.`,
    );
  }

  return { version, channel, commit };
}

// --- Core environment checks (R13) ----------------------------------------------

/** The running libc's version, when Node can report it. */
function runtimeGlibcVersion(): string | null {
  try {
    const report = process.report.getReport() as {
      header?: { glibcVersionRuntime?: unknown };
    };
    const version = report.header?.glibcVersionRuntime;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

function parseGlibc(version: string): { major: number; minor: number } | null {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * F1a: Unity's CLI requires glibc >= 2.34 on Linux. The comparison is numeric
 * (`2.9` is older than `2.34`, although it sorts later as a string).
 *
 * `platform` and `version` are injectable so the Linux branch is testable on
 * Windows/macOS, where the check is always `info` ("not applicable").
 */
export function glibcCheck(
  platform: NodeJS.Platform = process.platform,
  version: string | null = runtimeGlibcVersion(),
): PreflightCheck {
  if (platform !== 'linux') {
    return {
      id: 'glibc',
      status: 'info',
      code: 'GLIBC_NOT_APPLICABLE',
      blocking: false,
      message: `glibc >= ${GLIBC_FLOOR} is a Linux requirement; not applicable on ${platform}`,
      source: 'core',
    };
  }

  if (version === null) {
    return {
      id: 'glibc',
      status: 'info',
      code: 'GLIBC_UNKNOWN',
      blocking: false,
      message: `could not determine the glibc version; Unity's CLI requires glibc >= ${GLIBC_FLOOR}`,
      source: 'core',
    };
  }

  const parsed = parseGlibc(version);
  if (parsed === null) {
    return {
      id: 'glibc',
      status: 'info',
      code: 'GLIBC_UNKNOWN',
      blocking: false,
      message: `could not parse glibc version ${JSON.stringify(version)}; Unity's CLI requires glibc >= ${GLIBC_FLOOR}`,
      source: 'core',
    };
  }

  const floor = parseGlibc(GLIBC_FLOOR)!;
  const tooOld =
    parsed.major < floor.major ||
    (parsed.major === floor.major && parsed.minor < floor.minor);

  if (tooOld) {
    return {
      id: 'glibc',
      status: 'fail',
      code: 'GLIBC_TOO_OLD',
      blocking: true,
      message: `glibc ${version} is below Unity's required floor ${GLIBC_FLOOR}; the CLI is unsupported on this machine`,
      source: 'core',
    };
  }

  return {
    id: 'glibc',
    status: 'pass',
    code: 'GLIBC_OK',
    blocking: false,
    message: `glibc ${version} meets Unity's floor ${GLIBC_FLOOR}`,
    source: 'core',
  };
}

/** The subset of `fs.statfsSync`'s result the check needs, in number form. */
export interface StatfsResult {
  bsize: number | bigint;
  bavail: number | bigint;
}

export type StatfsFn = (path: string) => StatfsResult;

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(1)} MiB`;
}

/**
 * F1b: the Editor install and the project's `Library/` both need room. The
 * check is on the project root, where `Library/` lives, and the threshold is
 * `doctor.minFreeBytes` (default 10 GiB).
 *
 * A filesystem that cannot answer `statfs` is `info`, never a failure: the
 * check is advisory in that case, not a false red build.
 */
export function diskSpaceCheck(
  ctx: CoreContext,
  statfs: StatfsFn = statfsSync as unknown as StatfsFn,
): PreflightCheck {
  let free: number;
  try {
    const stats = statfs(ctx.projectPath);
    free = Number(stats.bsize) * Number(stats.bavail);
    if (!Number.isFinite(free) || free < 0) throw new Error('statfs returned no usable byte count');
  } catch (error) {
    return {
      id: 'disk-space',
      status: 'info',
      code: 'DISK_SPACE_UNKNOWN',
      blocking: false,
      message: `could not determine free space at ${ctx.projectPath}: ${(error as Error).message}; disk space was not checked`,
      source: 'core',
    };
  }

  const minimum = ctx.config.doctor.minFreeBytes;
  if (free < minimum) {
    return {
      id: 'disk-space',
      status: 'fail',
      code: 'DISK_SPACE_LOW',
      blocking: true,
      message: `${formatBytes(free)} free at ${ctx.projectPath}, below the configured floor ${formatBytes(minimum)} (doctor.minFreeBytes)`,
      source: 'core',
    };
  }

  return {
    id: 'disk-space',
    status: 'pass',
    code: 'DISK_SPACE_OK',
    blocking: false,
    message: `${formatBytes(free)} free at ${ctx.projectPath}; floor ${formatBytes(minimum)}`,
    source: 'core',
  };
}

/**
 * F1c: the CLI identity is a first-class check, not only a log line. Inside the
 * tested range `pass`; above the ceiling `info` (advisory); below the floor a
 * blocking failure. `doctor` calls `resolveCliIdentity` with
 * `throwBelowFloor: false` so this row can exist in the report.
 */
export function capabilityCheck(ctx: CoreContext): PreflightCheck {
  const version = ctx.cliVersion;
  if (version === null) {
    return {
      id: 'cli-version',
      status: 'info',
      code: 'CLI_VERSION_UNKNOWN',
      blocking: false,
      message: 'the Unity CLI version is unknown',
      source: 'core',
    };
  }

  const identity =
    `Unity CLI ${version} (channel ${ctx.cliChannel ?? 'unknown'}, commit ${ctx.cliCommit ?? 'unknown'})`;
  const status = cliVersionStatus(version);

  if (status === 'below') {
    return {
      id: 'cli-version',
      status: 'fail',
      code: 'CLI_VERSION_TOO_OLD',
      blocking: true,
      message: `${identity} is older than the tested floor ${TESTED_CLI_MIN}; upgrade the Unity CLI`,
      source: 'core',
    };
  }
  if (status === 'above') {
    return {
      id: 'cli-version',
      status: 'info',
      code: 'CLI_VERSION_NEWER',
      blocking: false,
      message: `${identity} is newer than the tested ceiling ${TESTED_CLI_MAX}; continuing, but its behaviour is unverified`,
      source: 'core',
    };
  }
  if (status === 'unknown') {
    return {
      id: 'cli-version',
      status: 'info',
      code: 'CLI_VERSION_UNKNOWN',
      blocking: false,
      message: `${identity} could not be compared with the tested range ${TESTED_CLI_MIN}..${TESTED_CLI_MAX}`,
      source: 'core',
    };
  }

  return {
    id: 'cli-version',
    status: 'pass',
    code: 'CLI_VERSION_TESTED',
    blocking: false,
    message: `${identity} is inside the tested range ${TESTED_CLI_MIN}..${TESTED_CLI_MAX}`,
    source: 'core',
  };
}

/** The cheap host checks `doctor` runs (setup deliberately does not). */
export function coreEnvironmentChecks(ctx: CoreContext): PreflightCheck[] {
  return [capabilityCheck(ctx), glibcCheck(), diskSpaceCheck(ctx)];
}

// --- Editor version and modules --------------------------------------------------

/**
 * Applies the same allow-list and `latest` gate to every Editor version,
 * whatever its source. `ProjectVersion.txt` is repository content, so a pull
 * request can choose it: an option-looking value there must never reach argv
 * (I1).
 */
function assertSafeEditorVersion(
  ctx: CoreContext,
  value: string,
  source: string,
): string {
  if (!SAFE_VERSION.test(value)) {
    throw new SetupError(
      `${source} ${JSON.stringify(value)} is not a valid Editor version: it reaches argv and must match ${SAFE_VERSION.source}.`,
      EXIT.CONFIG_ERROR,
    );
  }
  if (value === 'latest' && ctx.config.unity.cli.allowLatest !== true) {
    throw new SetupError(
      `${source} is "latest", which is opt-in: set unity.cli.allowLatest: true to accept an untested CLI/Editor.`,
      EXIT.CONFIG_ERROR,
    );
  }
  return value;
}

/** Resolves `unity.editor.version`, reading `ProjectVersion.txt` for `from-project`. */
export function resolveEditorVersion(ctx: CoreContext): string {
  const configured = ctx.config.unity.editor.version;

  if (configured === 'from-project') {
    const path = join(ctx.projectPath, 'ProjectSettings', 'ProjectVersion.txt');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new SetupError(
        `cannot resolve unity.editor.version: ${path} does not exist; run from a Unity project or set unity.editor.version explicitly.`,
        EXIT.CONFIG_ERROR,
      );
    }
    const match = text.match(/^\s*m_EditorVersion:\s*(\S+)/m);
    if (match === null) {
      throw new SetupError(
        `cannot resolve unity.editor.version: ${path} has no m_EditorVersion: line.`,
        EXIT.CONFIG_ERROR,
      );
    }
    return assertSafeEditorVersion(ctx, match[1]!, `${path} declares m_EditorVersion:`);
  }

  return assertSafeEditorVersion(ctx, configured, 'unity.editor.version');
}

interface EditorRow {
  version: string | null;
}

interface ModuleRow {
  id: string;
  isInstalled: boolean;
}

function editorRows(result: UnityResult): EditorRow[] {
  if (isUnsupportedCommand(result)) {
    throw new SetupError(
      'this Unity CLI does not support `editors --installed`; the toolkit cannot tell which Editors are installed.',
      EXIT.CONFIG_ERROR,
    );
  }
  if (result.code !== 0) {
    throw new SetupError(
      `\`unity editors --installed --format json\` failed (exit ${result.code})${resultDetail(result)}`,
      result.code,
    );
  }
  const data = result.json?.data;
  const rows = listingRows(data, ['editors']);
  if (rows.length === 0 && result.json === null) {
    throw new SetupError(
      '`unity editors --installed --format json` returned no machine-readable report.',
      EXIT.CONFIG_ERROR,
    );
  }
  return rows.map((raw) => {
    const row = asObject(raw);
    return { version: stringField(row, 'version') };
  });
}

function moduleRows(result: UnityResult): ModuleRow[] {
  if (isUnsupportedCommand(result)) {
    throw new SetupError(
      'this Unity CLI does not support `install --list-modules`; the toolkit cannot verify the Editor modules.',
      EXIT.CONFIG_ERROR,
    );
  }
  if (result.code !== 0) {
    throw new SetupError(
      `\`unity install <version> --list-modules --format json\` failed (exit ${result.code})${resultDetail(result)}`,
      result.code,
    );
  }
  const data = result.json?.data;
  const rows = listingRows(data, ['modules']);
  const modules: ModuleRow[] = [];
  for (const raw of rows) {
    const row = asObject(raw);
    const id = stringField(row, 'id');
    if (id === null) continue;
    modules.push({ id: id.toLowerCase(), isInstalled: row?.isInstalled === true });
  }
  return modules;
}

/**
 * The authoritative module check: `unity install <v> --list-modules` and its
 * `isInstalled` boolean, matched by lowercase id. The display-name `modules`
 * string on an `editors --installed` row is never compared against ids.
 */
async function missingModules(
  ctx: CoreContext,
  editorVersion: string,
  required: string[],
): Promise<string[]> {
  if (required.length === 0) return [];
  const result = await unityModulesList(unityBaseOptions(ctx), editorVersion);
  const rows = new Map(moduleRows(result).map((row) => [row.id, row.isInstalled]));
  return unique(required).filter(
    (id) => rows.get(id.toLowerCase()) !== true,
  );
}

/** The exact, copy-pasteable `unity install` command for a failure message. */
function installCommand(ctx: CoreContext, version: string, modules: string[]): string {
  const editor = ctx.config.unity.editor;
  const parts = ['unity', 'install', version];
  if (modules.length > 0) {
    parts.push('--module', ...modules);
    // `--cm`/`--no-cm` only mean anything with a module selection. Keep the
    // printed command identical to the argv `installEditor` runs (I4).
    parts.push(editor.childModules ? '--cm' : '--no-cm');
  }
  if (editor.architecture !== null) parts.push('--architecture', editor.architecture);
  if (editor.resume) parts.push('--resume');
  if (editor.headless) parts.push('--headless');
  parts.push('--yes', '--accept-eula');
  return parts.join(' ');
}

async function installEditor(
  ctx: CoreContext,
  version: string,
  modules: string[],
): Promise<void> {
  const editor = ctx.config.unity.editor;
  const result = await unityInstall(unityBaseOptions(ctx), {
    version,
    modules,
    // `--cm` only means anything with a module selection: without one it would
    // pull every child module (or is meaningless). Keep the argv in lockstep
    // with `installCommand`'s printed form in both directions (I4).
    childModules: modules.length > 0 ? editor.childModules : undefined,
    changeset: editor.changeset ?? undefined,
    architecture: editor.architecture ?? undefined,
    resume: editor.resume,
    headless: editor.headless,
    acceptEula: true,
  });
  if (isUnsupportedCommand(result)) {
    throw new SetupError(
      'this Unity CLI does not support `install`; install the Editor with the Hub or upgrade the CLI.',
      EXIT.CONFIG_ERROR,
    );
  }
  if (result.code !== 0) {
    throw new SetupError(
      `\`${installCommand(ctx, version, modules)}\` failed (exit ${result.code})${resultDetail(result)}`,
      result.code === 0 ? EXIT.COMMAND_FAILED : result.code,
    );
  }
}

// --- Doctor ---------------------------------------------------------------------

function isBlockingFailure(check: { status: string; blocking: boolean }): boolean {
  return check.blocking && check.status !== 'pass' && check.status !== 'info';
}

/** Normalises `unity doctor --ci --format json` into rows this toolkit can branch on. */
export function evaluateUnityDoctor(result: UnityResult): UnityDoctorEvaluation {
  const data = asObject(result.json?.data);
  const rawChecks = data === null ? null : data.checks;
  if (!Array.isArray(rawChecks)) {
    return { verdict: 'unknown', checks: [], reportOk: false };
  }

  const checks: UnityDoctorCheck[] = rawChecks.map((raw, index) => {
    const row = asObject(raw);
    return {
      id: stringField(row, 'id') ?? `check-${index}`,
      status: stringField(row, 'status') ?? 'fail',
      code: stringField(row, 'code') ?? '',
      blocking: row?.blocking === true,
      message: stringField(row, 'message') ?? '',
    };
  });

  const rawVerdict = stringField(data, 'verdict');
  const verdict: 'pass' | 'fail' | 'unknown' =
    rawVerdict === 'pass' || rawVerdict === 'fail'
      ? rawVerdict
      : checks.some(isBlockingFailure)
        ? 'fail'
        : 'pass';

  return { verdict, checks, reportOk: true };
}

// --- License --------------------------------------------------------------------

export interface LicenseStatusSummary {
  active: boolean;
  detail: string;
  licenses: string[];
  floatingServer: string | null;
  /** True when this CLI does not know `license status`. */
  unsupported: boolean;
}

/**
 * Reads `unity license status --format json` without deciding policy. The
 * policy is mode-aware (R17): under `license.mode: none` an inactive licence is
 * a failure; under an activation mode it is only reported, because the
 * lifecycle activates it after this preflight.
 */
export async function checkLicense(ctx: CoreContext): Promise<LicenseStatusSummary> {
  const result = await unityLicenseStatus(unityBaseOptions(ctx));
  const unsupported = isUnsupportedCommand(result);
  const data = asObject(result.json?.data);
  const active = data?.active === true;

  const licenses = asArray(data?.licenses)
    .map((raw) => {
      const row = asObject(raw);
      const product = stringField(row, 'product');
      const type = stringField(row, 'type');
      if (product === null) return null;
      return type === null ? product : `${product} (${type})`;
    })
    .filter((value): value is string => value !== null);

  const floatingServer = stringField(data, 'floatingServer');

  const detail = active
    ? licenses.length > 0
      ? licenses.join(', ')
      : 'active'
    : unsupported
      ? 'this Unity CLI does not support `license status`'
      : result.code !== 0
        ? `exit ${result.code}${resultDetail(result)}`
        : 'no active license';

  return { active, detail, licenses, floatingServer, unsupported };
}

function licenseActivationHint(ctx: CoreContext): string {
  return (
    `activate one first — for example \`unity license activate --serial\` with ${ctx.config.license.serialEnv} set, ` +
    'or `unity license activate --floating` / `--file <license.ulf>` — or set license.mode to serial, floating or offline-file'
  );
}

// --- Private git packages -------------------------------------------------------

/** Reads the project's git dependencies, turning a broken manifest into exit 64. */
export function loadGitDependencies(ctx: CoreContext): GitDependency[] {
  try {
    return readGitDependencies(ctx.projectPath);
  } catch (error) {
    throw new SetupError(
      `cannot read the project's package dependencies: ${(error as Error).message}`,
      EXIT.CONFIG_ERROR,
    );
  }
}

/**
 * Refuses a project whose manifest embeds credentials in a git URL. Unity
 * copies that URL verbatim into the committed `packages-lock.json`, so running
 * would write the secret into the repository (GC21).
 */
export function refuseEmbeddedCredentials(dependencies: GitDependency[]): void {
  const bad = dependencies.find((dependency) => dependency.hasEmbeddedCredentials);
  if (bad === undefined) return;
  throw new SetupError(
    `package "${bad.name}" declares a git URL with embedded credentials (${redactGitUrl(bad.url)}). ` +
      'Unity copies that URL verbatim into the committed Packages/packages-lock.json, so the credential would land in the repository. ' +
      'Replace it with a credential-free URL and supply the credential through a git URL rewrite (see docs/private-packages.md).',
    EXIT.CONFIG_ERROR,
  );
}

/** Formats the blocking git-preflight failures for a command's error output. */
export function describeGitFailures(
  results: Awaited<ReturnType<typeof preflightGitDependencies>>,
  redactor: Redactor,
): string {
  const failures = results.filter((result) => !result.reachable);
  return failures
    .map(({ dependency, detail }) =>
      redactor.redact(
        `${dependency.name} (${dependency.url}) is not fetchable: ${detail}`,
      ),
    )
    .join('; ');
}

// --- The preflight --------------------------------------------------------------

function normaliseSetupInput(input: SetupInput): SetupOptions {
  if (!Array.isArray(input)) return input;
  // An explicit empty array is not an override: it must not silently disable
  // the module check for the invoked command (M7).
  return input.length > 0 ? { requiredModules: input } : {};
}

/**
 * The target a build's module requirement derives from.
 *
 * `options.target === undefined` means "the configured target"; `null` means
 * "no target is known" (a profile-only build). The distinction is deliberate:
 * an empty target must not silently skip the check — the caller says `null`
 * when it means it, and `setup` then warns.
 */
function buildTargetFor(ctx: CoreContext, options: SetupOptions): string | null {
  const target =
    options.target === undefined ? ctx.config.build.target : options.target;
  return typeof target === 'string' && target.trim() !== '' ? target.trim() : null;
}

/**
 * The command owns its module requirement. A non-empty `requiredModules`
 * override always wins; otherwise a build derives from the target on the given
 * host and a test from the configured test modes. No command means no module
 * requirement — the spec's version-only check.
 */
function requiredModulesFor(
  ctx: CoreContext,
  options: SetupOptions,
  host: HostPlatform,
): string[] {
  if (options.requiredModules !== undefined && options.requiredModules.length > 0) {
    return unique(options.requiredModules);
  }
  if (options.command === 'build') {
    const target = buildTargetFor(ctx, options);
    return target === null ? [] : unique(modulesForBuildTarget(target, host));
  }
  if (options.command === 'test') {
    return unique(ctx.config.test.modes.flatMap((mode) => modulesForTestMode(mode)));
  }
  return [];
}

/**
 * Resolves the CLI identity, then the Editor version and modules, then terms,
 * the licence precondition and the private-git preflight.
 *
 * `setup` deliberately does **not** run `unity doctor --ci` or the host checks
 * (glibc, disk space, capability matrix): those belong to `unityci doctor`,
 * which the run path invokes once, after setup and before the licence step.
 *
 * The module requirement belongs to the **invoked command**:
 * `setup(ctx, { command: 'build' })` derives it from `config.build.target`,
 * `{ command: 'build', target: null }` says no target is known (a profile-only
 * build) and skips the target-driven check with a warning,
 * `{ command: 'test' }` checks no platform module, and `setup(ctx)` checks only
 * the Editor version. `requiredModules` is an explicit, non-empty override.
 *
 * The core never installs silently: a missing Editor or module always requires
 * `unity.editor.acceptEula: true`, and `--allow-install` is never sent.
 */
export async function setup(
  ctx: CoreContext,
  input: SetupInput = {},
): Promise<SetupResult> {
  const options = normaliseSetupInput(input);
  const identity = await resolveCliIdentity(ctx);
  const host = options.host ?? hostPlatform();

  if (ctx.config.unity.editor.headless && host !== 'linux') {
    throw new SetupError(
      'unity.editor.headless installs the headless Linux Editor, which is only available on Linux; ' +
        `this host is ${host}. Clear unity.editor.headless to install the regular Editor.`,
      EXIT.CONFIG_ERROR,
    );
  }

  const editorVersion = resolveEditorVersion(ctx);
  ctx.editorVersion = editorVersion;

  if (options.command === 'build') {
    const target = buildTargetFor(ctx, options);
    if (target === null) {
      // A profile-only build: the profile defines the target, and the profile
      // asset is the only place the module requirement is known. Never guess
      // from the config default (that demanded windows-il2cpp on a Linux
      // runner building a Linux profile), and never skip it silently.
      ctx.logger.warn(
        'no build target was supplied for this build, so the required Editor modules cannot be derived; ' +
          "when a build profile defines the target, install that profile target's modules from the profile's own requirements.",
      );
    } else {
      const support = isBuildTargetSupportedOnHost(target, host);
      if (!support.supported) {
        throw new SetupError(
          `build target ${target} cannot be built here: ${support.reason ?? 'unsupported host'}.`,
          EXIT.CONFIG_ERROR,
        );
      }
    }
  }

  const required = requiredModulesFor(ctx, options, host);
  const configuredModules = ctx.config.unity.editor.modules;
  const installModules = unique([...configuredModules, ...required]);
  let installed = false;

  const editors = editorRows(await unityEditorsInstalled(unityBaseOptions(ctx)));
  const present = editors.some((row) => row.version === editorVersion);

  if (!present) {
    if (!ctx.config.unity.editor.acceptEula) {
      throw new SetupError(
        `the Unity Editor ${editorVersion} is not installed. Run \`${installCommand(ctx, editorVersion, installModules)}\`, ` +
          'or set unity.editor.acceptEula: true to let the toolkit run it.',
        EXIT.CONFIG_ERROR,
      );
    }
    await installEditor(ctx, editorVersion, installModules);
    installed = true;
  }

  if (required.length > 0) {
    let missing = await missingModules(ctx, editorVersion, required);
    if (missing.length > 0) {
      const command = installCommand(ctx, editorVersion, missing);
      if (!ctx.config.unity.editor.acceptEula) {
        throw new SetupError(
          `the installed Unity Editor ${editorVersion} is missing the required module${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. ` +
            `Run \`${command}\`, or set unity.editor.acceptEula: true to let the toolkit run it.`,
          EXIT.CONFIG_ERROR,
        );
      }
      await installEditor(ctx, editorVersion, missing);
      installed = true;
      missing = await missingModules(ctx, editorVersion, required);
      if (missing.length > 0) {
        throw new SetupError(
          `the Unity Editor ${editorVersion} is still missing module${missing.length === 1 ? '' : 's'} ${missing.join(', ')} after \`${command}\`.`,
          EXIT.CONFIG_ERROR,
        );
      }
    }
  }

  if (ctx.config.unity.editor.terms) {
    const terms = await unityTermsAccept(unityBaseOptions(ctx), editorVersion);
    if (isUnsupportedCommand(terms)) {
      throw new SetupError(
        'this Unity CLI does not support `terms accept`; the Editor terms cannot be accepted with this CLI.',
        EXIT.CONFIG_ERROR,
      );
    }
    if (terms.code !== 0) {
      throw new SetupError(
        `\`unity terms accept ${editorVersion} --yes\` failed (exit ${terms.code})${resultDetail(terms)}`,
        terms.code === 0 ? EXIT.COMMAND_FAILED : terms.code,
      );
    }
  }

  const license = await checkLicense(ctx);
  if (license.unsupported) {
    throw new SetupError(
      'this Unity CLI does not support `license status`; the toolkit cannot verify the licence precondition.',
      EXIT.CONFIG_ERROR,
    );
  }
  if (!license.active) {
    if (ctx.config.license.mode === 'none') {
      throw new SetupError(
        `no active Unity license (${license.detail}). A run with license.mode: none requires one: ${licenseActivationHint(ctx)}.`,
        EXIT.CONFIG_ERROR,
      );
    }
    ctx.logger.warn(
      `no active Unity license yet (${license.detail}); license.mode "${ctx.config.license.mode}" will activate it in the lifecycle.`,
    );
  }

  if (ctx.config.packages.preflight) {
    const dependencies = loadGitDependencies(ctx);
    refuseEmbeddedCredentials(dependencies);
    const results = await preflightGitDependencies(dependencies, {
      cwd: ctx.projectPath,
      env: ctx.env,
      logger: ctx.logger,
      redactor: ctx.redactor,
    });
    if (results.some((result) => !result.reachable)) {
      throw new SetupError(
        `the project's private git package${results.length === 1 ? '' : 's'} cannot be fetched: ${describeGitFailures(results, ctx.redactor)}. ` +
          'Fix the credential with a git URL rewrite or correct the package URL.',
        EXIT.CONFIG_ERROR,
      );
    }
  }

  return {
    editorVersion,
    cliVersion: identity.version,
    cliChannel: identity.channel,
    cliCommit: identity.commit,
    installed,
    // `doctor` runs separately in the run path; setup no longer produces a
    // verdict of its own.
    doctorVerdict: 'unknown',
  };
}
