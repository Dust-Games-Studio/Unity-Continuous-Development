/**
 * `unityci run <test|build>`: the command layer around the run lifecycles.
 *
 * It owns exactly two things: refusing an invalid configuration before anything
 * runs (exit 64, nothing spawned), and turning the lifecycle's verdict into a
 * process exit code. The lifecycle itself owns the ordering, the licence
 * teardown and `summary.json`.
 */
import { resolve } from 'node:path';
import { validateConfig } from '../config/validate.js';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { runBuild } from '../lifecycle/build.js';
import { runTest } from '../lifecycle/test.js';
import { buildSummary, writeSummary } from '../report/summary.js';

/** The configured Editor version, for a summary written before `setup` ran. */
function configuredEditorVersion(ctx: CoreContext): string {
  const configured = ctx.config.unity.editor.version;
  // `from-project` is unknown until setup reads ProjectVersion.txt; an empty
  // value is honest, a guessed one is not.
  return configured === 'from-project' ? '' : configured;
}

/**
 * Writes a `config_error` summary before returning 64.
 *
 * The summary is written on every failed path (decision 6): a stale green
 * `summary.json` left on disk after a configuration error is worse than no
 * summary at all. A failure to write it is logged and never changes the primary
 * exit code — it is a report of the failure, not the failure itself.
 */
function writeConfigErrorSummary(ctx: CoreContext, command: 'test' | 'build'): void {
  const outputDir = resolve(ctx.projectPath, ctx.config.output.dir);
  const summary = buildSummary({
    command,
    status: 'config_error',
    exitCode: EXIT.CONFIG_ERROR,
    cliVersion: ctx.redactor.redact(ctx.cliVersion ?? ''),
    cliChannel: ctx.cliChannel === null ? null : ctx.redactor.redact(ctx.cliChannel),
    cliCommit: ctx.cliCommit === null ? null : ctx.redactor.redact(ctx.cliCommit),
    editorVersion: ctx.redactor.redact(configuredEditorVersion(ctx)),
    durationMs: Math.max(0, Date.now() - ctx.startedAt),
    license: {
      mode: ctx.config.license.mode,
      activated: false,
      returned: false,
      seatLeaked: false,
    },
  });

  try {
    writeSummary(outputDir, summary);
  } catch (error) {
    ctx.logger.error(
      `could not write summary.json under ${outputDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `unityci run test|build`.
 *
 * A configuration problem is exit 64 with nothing spawned; otherwise the
 * lifecycle's exit code is returned verbatim: 0 passed, 8 tests failed, 6 when
 * nothing usable was produced, 65 for a malformed artifact, and the raw Unity
 * code for any infrastructure failure (11, 12, 14 …).
 */
export async function runCommand(
  ctx: CoreContext,
  sub: 'test' | 'build',
): Promise<number> {
  const issues = validateConfig(ctx.config, ctx.projectPath);
  if (issues.length > 0) {
    for (const issue of issues) {
      ctx.logger.error(`${issue.path}: ${issue.message}`);
    }
    writeConfigErrorSummary(ctx, sub);
    return EXIT.CONFIG_ERROR;
  }

  if (sub === 'build') {
    const result = await runBuild(ctx);
    return result.exitCode;
  }

  const result = await runTest(ctx);
  return result.exitCode;
}
