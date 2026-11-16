/**
 * `run build`: the build-side hooks of the shared lifecycle.
 *
 * The sequence — `doctor` → `setup` → activate → execute → verify → `finally`
 * teardown — lives in `run-lifecycle.ts`. This module owns what is specific to
 * a build: the `unity build` invocation and its retry, the target preflight,
 * and the artifact/provenance verification.
 *
 * A build produces a player (a file or a directory), and an exit 0 with nothing
 * at `--output` is the build-side false green (R18), exactly like a test
 * run with no NUnit report. "Nothing" excludes every file the toolkit writes
 * itself: the provenance manifest it asks Unity to write is a sibling of the
 * default output directory and must not satisfy the check.
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../config/schema.js';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { isUnsupportedCommand, unityBuild } from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';
import {
  isNonEmptyFile,
  reportPath,
  runLifecycle,
  runWithRetry,
} from './run-lifecycle.js';
import { acceleratorArgs, editorIdentityArgs } from './editor-args.js';
import { unityBaseOptions } from './setup.js';

/** The verdict of one `run build`. A build is either usable or it is not. */
export interface BuildRunResult {
  status: 'passed' | 'infra_failed';
  exitCode: number;
  unityExitCode: number;
  attempts: number;
  artifacts: string[];
  provenance: Record<string, unknown> | null;
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

/**
 * Paths the toolkit itself writes into `output.dir`. They are sibling to (or,
 * with a broad `build.outputPath`, inside) the build output, so they must never
 * satisfy the artifact check: the provenance manifest the core asks Unity to
 * write could otherwise be the only thing "produced".
 */
interface ToolkitPaths {
  /** Exact files, resolved absolute. */
  files: ReadonlySet<string>;
  /** Entire trees the toolkit owns, resolved absolute. */
  roots: readonly string[];
}

/** True when `path` is `root` or sits below it, on resolved paths. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolved-path membership, never a string-prefix comparison. */
function isToolkitPath(path: string, toolkit: ToolkitPaths): boolean {
  const absolute = resolve(path);
  if (toolkit.files.has(absolute)) return true;
  return toolkit.roots.some((root) => isInside(root, absolute));
}

/**
 * True when the output path holds something the build produced (R18).
 *
 * `build.outputPath` may be either a file or a directory. An empty directory,
 * or one holding only the toolkit's own files, is not a produced artifact.
 */
function artifactHasContent(path: string, toolkit: ToolkitPaths): boolean {
  const absolute = resolve(path);
  if (isToolkitPath(absolute, toolkit)) return false;
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) return stats.size > 0;
    if (!stats.isDirectory()) return false;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (artifactHasContent(join(absolute, entry.name), toolkit)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The newest modification time of anything the build produced, or `-Infinity`
 * when nothing is left after ignoring the toolkit's files.
 *
 * A retry that exits 0 must have written something itself; a file's own mtime
 * says so directly, but a build directory's own mtime does not change when a
 * contained file is overwritten, so every entry is considered. A build never
 * renders, so the tree is finite and walking it is cheap relative to a build.
 */
function artifactModifiedAt(path: string, toolkit: ToolkitPaths): number {
  const absolute = resolve(path);
  if (isToolkitPath(absolute, toolkit)) return Number.NEGATIVE_INFINITY;
  try {
    const stats = statSync(absolute);
    if (stats.isFile()) return stats.mtimeMs;
    if (!stats.isDirectory()) return Number.NEGATIVE_INFINITY;

    // A directory's own mtime is not the build's: creating the toolkit's
    // provenance manifest inside it would make the directory look fresh even
    // when every produced file is old. Only the non-ignored files count.
    let newest = Number.NEGATIVE_INFINITY;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = artifactModifiedAt(join(absolute, entry.name), toolkit);
      if (child > newest) newest = child;
    }
    return newest;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/** The configured target, with the empty string meaning "not set". */
function configuredTarget(ctx: CoreContext): string {
  return typeof ctx.config.build.target === 'string' ? ctx.config.build.target.trim() : '';
}

/** True when a build profile defines the target. */
function hasBuildProfile(ctx: CoreContext): boolean {
  const profile = ctx.config.build.profile;
  return typeof profile === 'string' && profile.trim() !== '';
}

/**
 * The target `setup` must derive its module requirement from.
 *
 * - No profile: the configured target.
 * - Profile only, with no target or the documented default target: `null`. The
 *   profile defines what is built, so deriving modules from the default would
 *   demand the wrong module (a Linux runner building a Linux profile asked for
 *   `windows-il2cpp`), and `''` used to skip the check without a word.
 * - Profile plus a target that differs from the documented default: that
 *   target, so its modules are still verified.
 *
 * The merged `Config` does not record which layer set a value, so an explicitly
 * configured target equal to the default is indistinguishable from the default
 * and is treated as implicit; that is harmless because the profile defines the
 * target anyway.
 */
function setupTarget(ctx: CoreContext): string | null {
  const target = configuredTarget(ctx);
  if (!hasBuildProfile(ctx)) return target === '' ? null : target;
  if (target === '' || target === DEFAULT_CONFIG.build.target) return null;
  return target;
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

/** `data.items` in 1.0.x, or the legacy `data` / `data.targets` shape. */
function targetRows(result: UnityResult): BuildTargetRow[] | null {
  const data = result.json?.data;
  const raw = Array.isArray(data) ? data : asObject(data)?.items ?? asObject(data)?.targets;
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
  // A build profile defines the target, so there is no `--target` to validate
  // and no execute method to require.
  if (hasBuildProfile(ctx)) return null;

  const target = configuredTarget(ctx);
  if (target === '') {
    // `validateConfig` rejects this before anything runs; the guard keeps a
    // hand-built context from invoking `unity build` with neither selector.
    ctx.logger.error(
      'no build target is configured and no build profile is set: `unity build --target` is required unless `--profile` is used.',
    );
    return { code: EXIT.CONFIG_ERROR, unityExitCode: EXIT.SUCCESS };
  }

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
 * with the exact install command, not download mid-run. `--output` is always
 * sent even for a zero-code target; the CLI requires it. 1.0.0 renamed
 * `--output-path` to `--output`; the old spelling still works silently, but
 * only the documented one is emitted.
 *
 * `--target` and `--profile` are exclusive on argv: a profile defines the
 * target, and `--target` is only required when no profile is used.
 *
 * `--no-tail` is unconditional. `unity build` streams the Editor log to stdout
 * by default, and `--format json` does **not** turn that off (only `--quiet`
 * and `--format ndjson` do), so without it the JSON reader sees an interleaved
 * log (GC12). The log still lands in `--log-file`.
 *
 * `-nographics` is deliberately **not** sent. `unity build` already spawns the
 * Editor in batch mode, and the CLI rejects its own reserved flags on `--args`
 * (a real build exited 6 with "Forwarded argument '-nographics' conflicts with
 * a reserved Unity flag"). The flag remains a `unity test` concern, where the
 * `--` separator delivers it to the Editor.
 */
function buildArguments(
  ctx: CoreContext,
  outputPath: string,
  logFile: string,
  provenancePath: string,
): string[] {
  const build = ctx.config.build;
  const args = [ctx.projectPath];
  const profile = build.profile;

  if (typeof profile === 'string' && profile.trim() !== '') {
    args.push('--profile', profile);
  } else {
    args.push('--target', configuredTarget(ctx));
  }

  args.push(
    '--output',
    outputPath,
    '--log-file',
    logFile,
  );

  if (build.provenance) {
    args.push('--provenance-path', provenancePath);
  } else {
    // 1.0.x: an explicit opt-out. Without a path the CLI writes nothing anyway,
    // but the flag is the documented contract and keeps the intent legible in
    // the logged argv.
    args.push('--no-provenance');
  }

  args.push(...editorIdentityArgs(ctx));

  if (build.buildTargetGroup !== null) {
    args.push('--build-target-group', build.buildTargetGroup);
  }

  args.push(...acceleratorArgs(ctx), '--no-tail');

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
  if (build.androidExportType !== null) {
    args.push('--android-export-type', build.androidExportType);
  }
  if (build.androidVersionCode !== null) {
    args.push('--android-version-code', String(build.androidVersionCode));
  }
  if (build.androidTargetSdkVersion !== null) {
    args.push('--android-target-sdk-version', String(build.androidTargetSdkVersion));
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

/** One successful invocation, as the verify step needs it. */
interface BuildRunSummary {
  code: number;
  attempts: number;
  lastAttemptStartedAt: number;
}

/** The payload one build's execute hands to its verify step. */
type BuildExecution =
  | { problem: TargetProblem; run: null }
  | { problem: null; run: BuildRunSummary };

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
  // Everything under output.dir that the toolkit writes itself. The test
  // reports live under their own configured directory, so the whole tree is
  // ignored rather than a guessed set of file names.
  const testDir = resolve(ctx.projectPath, ctx.config.test.outputDir);
  const toolkit: ToolkitPaths = {
    files: new Set(
      [
        provenanceFile,
        logFile,
        join(summaryDir, 'logs', 'doctor.json'),
        join(summaryDir, 'summary.json'),
      ].map((path) => resolve(path)),
    ),
    // Never ignore a tree that contains the build output itself (a broad
    // `test.outputDir` must not turn every build into "produced nothing").
    roots: isInside(testDir, outputPath) ? [] : [testDir],
  };

  const artifacts: string[] = [];
  let provenance: Record<string, unknown> | null = null;

  const execution = await runLifecycle<BuildExecution>(ctx, {
    command: 'build',
    setupOptions: { command: 'build', target: setupTarget(ctx) },
    doctorSubject: 'build',
    execute: async (ctx) => {
      const problem = await validateTarget(ctx);
      if (problem !== null) {
        return {
          data: { problem, run: null },
          unityExitCode: problem.unityExitCode,
          attempts: 1,
        };
      }

      mkdirSync(dirname(logFile), { recursive: true });
      if (ctx.config.build.provenance) {
        mkdirSync(dirname(provenanceFile), { recursive: true });
        removeStaleFile(provenanceFile);
      }
      removeStaleFile(logFile);

      let lastAttemptStartedAt = 0;
      const args = buildArguments(ctx, outputPath, logFile, provenanceFile);
      const run = await runWithRetry<number>(
        ctx,
        'unity build',
        async () => {
          const result = await unityBuild(unityBaseOptions(ctx), args);
          return { value: result.code, code: result.code };
        },
        () => {
          removeStaleFile(logFile);
          removeStaleFile(provenanceFile);
          lastAttemptStartedAt = Date.now();
        },
      );

      return {
        data: {
          problem: null,
          run: {
            code: run.code,
            attempts: run.attempts,
            lastAttemptStartedAt,
          },
        },
        unityExitCode: run.code,
        attempts: run.attempts,
      };
    },
    verify: async (ctx, result) => {
      if (result.data.problem !== null) return { exitCode: result.data.problem.code };
      const run = result.data.run;

      let manifestMalformed = false;
      if (ctx.config.build.provenance) {
        const manifest = readProvenance(provenanceFile);
        provenance = manifest.provenance;
        manifestMalformed = manifest.malformed;
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
      }

      const artifactProduced = artifactHasContent(outputPath, toolkit);
      if (run.code !== EXIT.SUCCESS) {
        // The invocation itself failed: Unity's code is the primary verdict,
        // even if an earlier or partial artifact happens to exist.
        if (ctx.config.build.profile !== null && run.code === EXIT.COMMAND_FAILED) {
          ctx.logger.error(
            `the build exited 6 with a configured --profile: the project may have no build profile at ${ctx.config.build.profile}.`,
          );
        }
        return { exitCode: run.code };
      }

      if (!artifactProduced) {
        // The build-side false green: Unity said success and wrote nothing
        // usable (R18).
        ctx.logger.error(
          `unity build exited 0 but produced no non-empty artifact at ${outputPath}; the build has no verdict.`,
        );
        return { exitCode: EXIT.COMMAND_FAILED };
      }

      if (
        run.attempts > 1 &&
        artifactModifiedAt(outputPath, toolkit) < run.lastAttemptStartedAt
      ) {
        // The retry exited 0 but touched nothing: the non-empty output is the
        // previous attempt's artifact, which is not this run's verdict (R18).
        // Deleting a user-configured output path is not acceptable, so the
        // freshness check is the guard instead.
        ctx.logger.error(
          `unity build exited 0 on attempt ${run.attempts} but nothing at ${outputPath} was modified by that attempt; the artifact belongs to an earlier attempt and the build has no verdict.`,
        );
        return { exitCode: EXIT.COMMAND_FAILED };
      }

      artifacts.push(reportPath(summaryDir, outputPath));
      // A produced artifact that cannot be read is a malformed artifact (GC7),
      // not a green build with a missing key.
      return { exitCode: manifestMalformed ? EXIT.INTERNAL_ERROR : EXIT.SUCCESS };
    },
    summary: (ctx) => ({
      fields: {
        artifacts,
        // GC10: `unity build` takes --log-file. Publish the path only when the
        // Editor actually wrote a non-empty log; `unity test` has no such flag.
        logs: {
          editor: isNonEmptyFile(logFile) ? reportPath(summaryDir, logFile) : null,
          cli: null,
        },
      },
      extras: {
        // The provenance manifest is a build-only key; `Summary` stays the
        // documented shape and this intersection keeps the extra key honest.
        provenance: provenance === null ? null : redactProvenance(ctx, provenance),
      },
    }),
  });

  return {
    status: execution.exitCode === EXIT.SUCCESS ? 'passed' : 'infra_failed',
    exitCode: execution.exitCode,
    unityExitCode: execution.unityExitCode,
    attempts: execution.attempts,
    artifacts,
    provenance,
  };
}
