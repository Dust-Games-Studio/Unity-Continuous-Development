import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import type { GitDependency } from '../packages/deps.js';
import { readGitDependencies, redactGitUrl } from '../packages/deps.js';
import { preflightGitDependencies } from '../packages/git.js';
import {
  TESTED_CLI_MAX,
  TESTED_CLI_MIN,
  unityDoctorCi,
  unityEditorsInstalled,
  unityInstall,
  unityLicenseStatus,
  unityModulesList,
  unityTermsAccept,
  unityVersion,
  type UnityBaseOptions,
} from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';

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
  doctorVerdict: 'pass' | 'fail' | 'unknown';
}

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
 * A deliberately small, semver-ish parser: the tested range is
 * `1.0.0-beta.9` … `1.0.0-beta.14`, so only the numeric triple and a
 * `-channel.N` suffix are meaningful. Build metadata is ignored.
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

/**
 * Reads `unity version --format json` — never `unity --version`, which
 * self-reported a different build on the spike machine — records the identity
 * on the context, and applies GC17: below the tested floor is exit 64, above
 * the ceiling is a warning.
 */
export async function resolveCliIdentity(
  ctx: CoreContext,
): Promise<{ version: string; channel: string | null; commit: string | null }> {
  const result = await unityVersion(unityBaseOptions(ctx));
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

  const belowFloor = compareCliVersions(version, TESTED_CLI_MIN);
  const aboveCeiling = compareCliVersions(version, TESTED_CLI_MAX);

  if (belowFloor === null || aboveCeiling === null) {
    ctx.logger.warn(
      `Unity CLI version ${version} is not comparable to the tested range ${TESTED_CLI_MIN}..${TESTED_CLI_MAX}; continuing without a version verdict.`,
    );
  } else {
    if (belowFloor < 0) {
      throw new SetupError(
        `Unity CLI ${version} is older than the tested floor ${TESTED_CLI_MIN}; upgrade the Unity CLI before running this pipeline.`,
        EXIT.CONFIG_ERROR,
      );
    }
    if (aboveCeiling > 0) {
      ctx.logger.warn(
        `Unity CLI ${version} is newer than the tested ceiling ${TESTED_CLI_MAX}; continuing, but this build's behaviour is unverified.`,
      );
    }
  }

  return { version, channel, commit };
}

// --- Editor version and modules --------------------------------------------------

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
    return match[1]!;
  }

  if (!SAFE_VERSION.test(configured)) {
    throw new SetupError(
      `unity.editor.version ${JSON.stringify(configured)} is not a valid Editor version: it reaches argv and must match ${SAFE_VERSION.source}.`,
      EXIT.CONFIG_ERROR,
    );
  }
  if (configured === 'latest' && ctx.config.unity.cli.allowLatest !== true) {
    throw new SetupError(
      'unity.editor.version is "latest", which is opt-in: set unity.cli.allowLatest: true to accept an untested CLI/Editor.',
      EXIT.CONFIG_ERROR,
    );
  }
  return configured;
}

interface EditorRow {
  version: string | null;
  modules: string;
}

interface ModuleRow {
  id: string;
  isInstalled: boolean;
}

function editorRows(result: UnityResult): EditorRow[] {
  if (result.code !== 0) {
    throw new SetupError(
      `\`unity editors --installed --format json\` failed (exit ${result.code})${resultDetail(result)}`,
      result.code,
    );
  }
  const data = result.json?.data;
  const rows = Array.isArray(data) ? data : asArray(asObject(data)?.editors);
  if (rows.length === 0 && result.json === null) {
    throw new SetupError(
      '`unity editors --installed --format json` returned no machine-readable report.',
      EXIT.CONFIG_ERROR,
    );
  }
  return rows.map((raw) => {
    const row = asObject(raw);
    return {
      version: stringField(row, 'version'),
      modules: stringField(row, 'modules') ?? '',
    };
  });
}

function moduleRows(result: UnityResult): ModuleRow[] {
  if (result.code !== 0) {
    throw new SetupError(
      `\`unity install <version> --list-modules --format json\` failed (exit ${result.code})${resultDetail(result)}`,
      result.code,
    );
  }
  const data = result.json?.data;
  const rows = Array.isArray(data) ? data : asArray(asObject(data)?.modules);
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
function installCommand(
  version: string,
  modules: string[],
  childModules: boolean,
): string {
  const parts = ['unity', 'install', version];
  if (modules.length > 0) {
    parts.push('--module', ...modules);
    // `--cm` only has meaning with a module selection; without one it would
    // silently pull every child module of the Editor.
    if (childModules) parts.push('--cm');
  }
  parts.push('--yes', '--accept-eula');
  return parts.join(' ');
}

async function installEditor(
  ctx: CoreContext,
  version: string,
  modules: string[],
): Promise<void> {
  const result = await unityInstall(unityBaseOptions(ctx), {
    version,
    modules,
    childModules: ctx.config.unity.editor.childModules,
    changeset: ctx.config.unity.editor.changeset ?? undefined,
    acceptEula: true,
  });
  if (result.code !== 0) {
    throw new SetupError(
      `\`${installCommand(version, modules, ctx.config.unity.editor.childModules)}\` failed (exit ${result.code})${resultDetail(result)}`,
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
}

/**
 * Reads `unity license status --format json` without deciding policy. The
 * policy is mode-aware (R17): under `license.mode: none` an inactive licence is
 * a failure; under an activation mode it is only reported, because the
 * lifecycle activates it after this preflight.
 */
export async function checkLicense(ctx: CoreContext): Promise<LicenseStatusSummary> {
  const result = await unityLicenseStatus(unityBaseOptions(ctx));
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
    : result.code !== 0
      ? `exit ${result.code}${resultDetail(result)}`
      : 'no active license';

  return { active, detail, licenses, floatingServer };
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
): string {
  const failures = results.filter((result) => !result.reachable);
  return failures
    .map(
      ({ dependency, detail }) =>
        `${dependency.name} (${dependency.url}) is not fetchable: ${detail}`,
    )
    .join('; ');
}

// --- The preflight --------------------------------------------------------------

/**
 * Resolves the CLI identity, then the Editor version and modules, then terms,
 * the doctor report, the licence precondition and the private-git preflight.
 *
 * `requiredModules` belongs to the **invoked command**: a test run passes the
 * test platform's modules, a build its target's modules, and a command with no
 * module requirement passes none (the default). The core never installs
 * silently: a missing Editor or module always requires
 * `unity.editor.acceptEula: true`, and `--allow-install` is never sent.
 */
export async function setup(
  ctx: CoreContext,
  requiredModules: string[] = [],
): Promise<SetupResult> {
  const identity = await resolveCliIdentity(ctx);
  const editorVersion = resolveEditorVersion(ctx);

  const required = unique(requiredModules);
  const configuredModules = ctx.config.unity.editor.modules;
  const installModules = unique([...configuredModules, ...required]);
  const childModules = ctx.config.unity.editor.childModules;
  let installed = false;

  const editors = editorRows(await unityEditorsInstalled(unityBaseOptions(ctx)));
  const present = editors.some((row) => row.version === editorVersion);

  if (!present) {
    if (!ctx.config.unity.editor.acceptEula) {
      throw new SetupError(
        `the Unity Editor ${editorVersion} is not installed. Run \`${installCommand(editorVersion, installModules, childModules)}\`, ` +
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
      const command = installCommand(editorVersion, missing, childModules);
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
    if (terms.code !== 0) {
      throw new SetupError(
        `\`unity terms accept ${editorVersion} --yes\` failed (exit ${terms.code})${resultDetail(terms)}`,
        terms.code === 0 ? EXIT.COMMAND_FAILED : terms.code,
      );
    }
  }

  const doctorResult = await unityDoctorCi(unityBaseOptions(ctx));
  const doctor = evaluateUnityDoctor(doctorResult);
  if (!doctor.reportOk) {
    throw new SetupError(
      `\`unity doctor --ci --format json\` did not return a machine-readable report (exit ${doctorResult.code})${resultDetail(doctorResult)}`,
      EXIT.CONFIG_ERROR,
    );
  }
  const blocking = doctor.checks.filter(isBlockingFailure);
  if (blocking.length > 0) {
    throw new SetupError(
      `\`unity doctor --ci\` reported a blocking failure: ${blocking
        .map((check) => `${check.id}${check.code === '' ? '' : ` (${check.code})`}${check.message === '' ? '' : `: ${check.message}`}`)
        .join('; ')}`,
      EXIT.CONFIG_ERROR,
    );
  }

  const license = await checkLicense(ctx);
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
        `the project's private git package${results.length === 1 ? '' : 's'} cannot be fetched: ${describeGitFailures(results)}. ` +
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
    doctorVerdict: doctor.verdict,
  };
}
