/**
 * The build lifecycle: `doctor` → `setup` → activate → validate the target →
 * `unity build` → verify the artifact and provenance → `summary.json`, with an
 * unconditional licence teardown.
 *
 * It mirrors `runTest` deliberately, not by accident: the preflight comes
 * first, `setup` verifies or installs the Editor for the command's module
 * requirement, the licence is activated, and the teardown is entered on every
 * path. The difference is the artifact: a build produces a player (a file or a
 * directory), and an exit 0 with nothing at `--output-path` is the build-side
 * false green (R18), exactly like a test run with no NUnit report.
 *
 * `unity build --list-targets --format json` is consulted once before the
 * build. Its rows are the authority for whether a target needs
 * `--execute-method`; its human, tab-separated table is never parsed (GC12).
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { doctorCommand } from '../commands/doctor.js';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import {
  buildSummary,
  deriveStatus,
  writeSummary,
  type Summary,
} from '../report/summary.js';
import { isUnsupportedCommand, unityBuild } from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';
import {
  LicenseError,
  activateLicense,
  type LicenseActivation,
  type LicenseReturnResult,
} from './license.js';
import { withRetry } from './retry.js';
import { SetupError, setup, unityBaseOptions, type SetupResult } from './setup.js';
import {
  isNonEmptyFile,
  redactSummary,
  reportPath,
  teardownLicense,
} from './test.js';

/** The verdict of one `run build`. A build is either usable or it is not. */
export interface BuildRunResult {
  status: 'passed' | 'infra_failed';
  exitCode: number;
  unityExitCode: number;
  attempts: number;
  artifacts: string[];
  provenance: Record<string, unknown> | null;
}

/**
 * The two Android knobs the brief requires and the typed `Config['build']`
 * does not (yet) declare. They are read defensively so this module works both
 * with the current schema and with a schema that adds them.
 */
interface BuildConfigExtras {
  androidExportType?: string | null;
  androidTargetSdkVersion?: number | null;
}

/** One row of `unity build --list-targets --format json`. */
interface BuildTargetRow {
  target: string;
  zeroCode: boolean;
  requirement: string;
}

/** What the pre-build target validation found. */
interface TargetProblem {
  code: number;
  /** Unity's exit code when the list call itself failed; 0 for a config issue. */
  unityExitCode: number;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredEditorVersion(ctx: CoreContext): string {
  const configured = ctx.config.unity.editor.version;
  return configured === 'from-project' ? '' : configured;
}

/**
 * True for a non-empty file or a non-empty directory (R18).
 *
 * `build.outputPath` may be either: a desktop build writes a directory of
 * player files, while some targets write a single package. An empty directory
 * is not a produced artifact.
 */
function isNonEmptyArtifact(path: string): boolean {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return stats.size > 0;
    if (stats.isDirectory()) return readdirSync(path).length > 0;
    return false;
  } catch {
    return false;
  }
}

/**
 * Removes a previous attempt's manifest or log, so what is read (and
 * published) after a retry belongs to the last attempt. The build output itself
 * is deliberately never deleted: `output.dir` may be any directory inside the
 * project, and `build.outputPath` could name one the user did not intend to
 * lose.
 */
function removeStaleFile(path: string): void {
  try {
    if (!statSync(path).isFile()) return;
    rmSync(path, { force: true });
  } catch {
    // Missing is the normal state before the first attempt.
  }
}

/** `data` directly, or `data.targets`, as Unity's listing envelope allows. */
function targetRows(result: UnityResult): BuildTargetRow[] | null {
  const data = result.json?.data;
  const raw = Array.isArray(data) ? data : asObject(data)?.targets;
  if (!Array.isArray(raw)) return null;

  const rows: BuildTargetRow[] = [];
  for (const entry of raw) {
    const row = asObject(entry);
    if (row === null || typeof row.target !== 'string') continue;
    rows.push({
      target: row.target,
      zeroCode: row.zeroCode === true,
      requirement: typeof row.requirement === 'string' ? row.requirement : '',
    });
  }
  return rows;
}

/**
 * Validates the configured target against the CLI's machine-readable list.
 *
 * A non-zero-code target needs either `--execute-method` or a Unity 6+ build
 * profile. Failing here with 64 names both options instead of letting the
 * build start and fail minutes later. The human table is never read.
 */
async function validateTarget(ctx: CoreContext): Promise<TargetProblem | null> {
  const target = ctx.config.build.target;
  const result = await unityBuild(unityBaseOptions(ctx), [
    ctx.projectPath,
    '--list-targets',
  ]);

  if (isUnsupportedCommand(result)) {
    ctx.logger.error(
      'this Unity CLI does not support `unity build --list-targets`; the build target cannot be validated.',
    );
    return { code: EXIT.CONFIG_ERROR, unityExitCode: result.code };
  }
  if (result.code !== EXIT.SUCCESS) {
    ctx.logger.error(
      `\`unity build --list-targets\` failed with exit ${result.code}; the build was not started.`,
    );
    return { code: result.code, unityExitCode: result.code };
  }

  const rows = targetRows(result);
  if (rows === null) {
    ctx.logger.error(
      '`unity build --list-targets --format json` returned no machine-readable target list; the build target cannot be validated.',
    );
    return { code: EXIT.CONFIG_ERROR, unityExitCode: EXIT.SUCCESS };
  }

  const row = rows.find((candidate) => candidate.target === target);
  if (row === undefined) {
    const known = rows.map((candidate) => candidate.target).sort().join(', ');
    ctx.logger.error(
      `unknown build target ${target}: \`unity build --list-targets\` does not list it. Known targets: ${known}.`,
    );
    return { code: EXIT.CONFIG_ERROR, unityExitCode: EXIT.SUCCESS };
  }

  if (row.zeroCode) return null;

  const { executeMethod, profile } = ctx.config.build;
  const hasMethod = executeMethod !== null && executeMethod !== '';
  const hasProfile = profile !== null && profile !== '';
  if (hasMethod || hasProfile) return null;

  const requirement =
    row.requirement === '' ? 'it requires an execute method or a build profile' : row.requirement;
  ctx.logger.error(
    `build target ${target} needs --execute-method or a Unity 6+ build profile (--profile): ${requirement}. ` +
      'Set build.executeMethod or build.profile.',
  );
  return { code: EXIT.CONFIG_ERROR, unityExitCode: EXIT.SUCCESS };
}

/**
 * The caller-owned arguments for one `unity build` invocation.
 *
 * `--format json` is appended by `unityBuild` itself (GC12), never here, and
 * `--allow-install` is never sent: a missing Editor must fail fast in `setup`
 * with the exact install command, not download mid-run. `--output-path` is
 * always sent even for a zero-code target; the CLI requires it.
 */
function buildArguments(
  ctx: CoreContext,
  outputPath: string,
  logFile: string,
  provenancePath: string,
): string[] {
  const build = ctx.config.build;
  const extras = build as typeof build & BuildConfigExtras;
  const args = [
    ctx.projectPath,
    '--target',
    build.target,
    '--output-path',
    outputPath,
    '--log-file',
    logFile,
    '--provenance-path',
    provenancePath,
  ];

  if (build.profile !== null && build.profile !== '') {
    args.push('--profile', build.profile);
  }
  if (build.executeMethod !== null && build.executeMethod !== '') {
    args.push('--execute-method', build.executeMethod);
  }
  if (build.versioningStrategy !== 'none') {
    args.push('--versioning-strategy', build.versioningStrategy);
  }
  // `--build-version` is only meaningful for the custom strategy; Unity ignores
  // it otherwise, so sending it would publish a stamp that was never applied.
  if (build.versioningStrategy === 'custom' && build.buildVersion !== null) {
    args.push('--build-version', build.buildVersion);
  }
  if (typeof extras.androidExportType === 'string' && extras.androidExportType !== '') {
    args.push('--android-export-type', extras.androidExportType);
  }
  if (build.androidVersionCode !== null) {
    args.push('--android-version-code', String(build.androidVersionCode));
  }
  if (typeof extras.androidTargetSdkVersion === 'number') {
    args.push('--android-target-sdk-version', String(extras.androidTargetSdkVersion));
  }
  if (build.allowDirtyBuild) args.push('--allow-dirty-build');

  return args;
}

/**
 * Reads the provenance manifest Unity wrote, or reports why it could not.
 * `malformed` means the file exists and is non-empty but is not a JSON object.
 */
function readProvenance(path: string): {
  provenance: Record<string, unknown> | null;
  malformed: boolean;
} {
  if (!isNonEmptyFile(path)) return { provenance: null, malformed: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const object = asObject(parsed);
    return object === null
      ? { provenance: null, malformed: true }
      : { provenance: object, malformed: false };
  } catch {
    return { provenance: null, malformed: true };
  }
}

/** Masks every string inside the free-form manifest (GC5). */
function redactProvenance(
  ctx: CoreContext,
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return ctx.redactor.redact(value);
    if (Array.isArray(value)) return value.map(walk);
    const object = asObject(value);
    if (object === null) return value;
    const masked: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) masked[key] = walk(entry);
    return masked;
  };
  return walk(provenance) as Record<string, unknown>;
}

/**
 * `run build`: the core run loop.
 *
 * It never throws for an expected failure: every path writes `summary.json`
 * and returns a verdict, so a stale green summary cannot survive a failed
 * build. Exit codes: `0` passed; `6` nothing usable landed at the output path;
 * `64` a configuration problem (an unvalidated target, or a target that needs
 * an execute method and has none); `65` a produced artifact is malformed;
 * otherwise Unity's own exit code.
 */
export async function runBuild(ctx: CoreContext): Promise<BuildRunResult> {
  const summaryDir = resolve(ctx.projectPath, ctx.config.output.dir);
  const outputPath = resolve(ctx.projectPath, ctx.config.build.outputPath);
  const logFile = join(summaryDir, 'logs', 'editor.log');
  const provenanceFile = join(summaryDir, 'build', 'provenance.json');

  let setupResult: SetupResult | null = null;
  let activation: LicenseActivation | null = null;
  let teardown: LicenseReturnResult | null = null;

  const artifacts: string[] = [];
  let provenance: Record<string, unknown> | null = null;

  let exitCode: number = EXIT.SUCCESS;
  let unityExitCode: number = EXIT.SUCCESS;
  let attempts = 1;

  try {
    // The preflight gate (R11) comes first, as the spec's Section 4.5 orders it.
    const doctorCode = await doctorCommand(ctx);
    if (doctorCode !== EXIT.SUCCESS) {
      ctx.logger.error(
        `the doctor preflight failed with exit ${doctorCode}; refusing to run the build.`,
      );
      exitCode = doctorCode;
    } else {
      setupResult = await setup(ctx, { command: 'build' });
      activation = await activateLicense(ctx);
      // The gate every later teardown reads, including a signal-driven one that
      // cannot see this function's locals (Task 11).
      if (activation.activated) ctx.licenseActivated = true;

      const problem = await validateTarget(ctx);
      if (problem !== null) {
        exitCode = problem.code;
        unityExitCode = problem.unityExitCode;
      } else {
        mkdirSync(dirname(logFile), { recursive: true });
        mkdirSync(dirname(provenanceFile), { recursive: true });
        removeStaleFile(logFile);
        removeStaleFile(provenanceFile);

        const args = buildArguments(ctx, outputPath, logFile, provenanceFile);
        const run = await withRetry<number>(
          async () => {
            removeStaleFile(logFile);
            removeStaleFile(provenanceFile);
            const result = await unityBuild(unityBaseOptions(ctx), args);
            return { value: result.code, code: result.code };
          },
          ctx.config.retry,
          (info) => {
            ctx.logger.warn(
              `unity build exited ${info.code} on attempt ${info.attempt}; retrying in ${info.waitMs}ms.`,
            );
          },
        );

        attempts = run.attempts;
        unityExitCode = run.code;

        const manifest = readProvenance(provenanceFile);
        provenance = manifest.provenance;
        if (manifest.malformed) {
          ctx.logger.error(
            `the build provenance manifest at ${provenanceFile} is not a JSON object; it cannot be published.`,
          );
        } else if (provenance === null) {
          // Not a failure on its own, but an absent manifest is worth saying:
          // the build is still traceable through the CLI identity in the summary.
          ctx.logger.warn(
            `unity build wrote no provenance manifest at ${provenanceFile}; summary.json has no provenance.`,
          );
        }

        const artifactProduced = isNonEmptyArtifact(outputPath);
        if (unityExitCode !== EXIT.SUCCESS) {
          // The invocation itself failed: Unity's code is the primary verdict,
          // even if an earlier or partial artifact happens to exist.
          exitCode = unityExitCode;
          if (ctx.config.build.profile !== null && unityExitCode === EXIT.COMMAND_FAILED) {
            ctx.logger.error(
              `the build exited 6 with a configured --profile: the project may have no build profile at ${ctx.config.build.profile}.`,
            );
          }
        } else if (!artifactProduced) {
          // The build-side false green: Unity said success and wrote nothing
          // usable (R18).
          ctx.logger.error(
            `unity build exited 0 but produced no non-empty artifact at ${outputPath}; the build has no verdict.`,
          );
          exitCode = EXIT.COMMAND_FAILED;
        } else {
          artifacts.push(reportPath(summaryDir, outputPath));
          if (manifest.malformed) {
            // A produced artifact that cannot be read is a malformed artifact
            // (GC7), not a green build with a missing key.
            exitCode = EXIT.INTERNAL_ERROR;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof SetupError || error instanceof LicenseError) {
      ctx.logger.error(error.message);
      exitCode = error.exitCode;
    } else {
      ctx.logger.error(`the build run failed unexpectedly: ${describe(error)}`);
      exitCode = EXIT.INTERNAL_ERROR;
    }
  } finally {
    // GC9: the teardown is entered on every path, and its seat gate — not this
    // function's locals — decides whether anything is returned.
    teardown = await teardownLicense(ctx);

    const editorLog = isNonEmptyFile(logFile) ? reportPath(summaryDir, logFile) : null;
    const summary = buildSummary({
      command: 'build',
      status: deriveStatus(exitCode),
      exitCode,
      unityExitCode,
      attempts,
      cliVersion: ctx.cliVersion ?? '',
      cliChannel: ctx.cliChannel,
      cliCommit: ctx.cliCommit,
      editorVersion: setupResult?.editorVersion ?? configuredEditorVersion(ctx),
      durationMs: Math.max(0, Date.now() - ctx.startedAt),
      license: {
        mode: activation?.mode ?? ctx.config.license.mode,
        activated: activation?.activated === true,
        returned: teardown?.returned === true,
        seatLeaked: teardown?.seatLeaked === true,
      },
      artifacts,
      // GC10: `unity build` takes --log-file. Publish the path only when the
      // Editor actually wrote a non-empty log; `unity test` has no such flag.
      logs: { editor: editorLog, cli: null },
    });

    // The provenance manifest is a build-only key. `writeSummary` takes the
    // documented `Summary`; the intersection keeps the extra key honest.
    const published: Summary & { provenance: Record<string, unknown> | null } = {
      ...redactSummary(ctx, summary),
      provenance: provenance === null ? null : redactProvenance(ctx, provenance),
    };

    try {
      writeSummary(summaryDir, published);
      ctx.logger.info(
        `build status ${summary.status} (exit ${exitCode}); summary at ${join(summaryDir, 'summary.json')}.`,
      );
    } catch (error) {
      ctx.logger.error(`could not write summary.json under ${summaryDir}: ${describe(error)}`);
      exitCode = EXIT.INTERNAL_ERROR;
    }
  }

  return {
    status: exitCode === EXIT.SUCCESS ? 'passed' : 'infra_failed',
    exitCode,
    unityExitCode,
    attempts,
    artifacts,
    provenance,
  };
}
