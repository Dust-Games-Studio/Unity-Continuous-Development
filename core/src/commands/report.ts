/**
 * `unityci report`: reads the reports a test run left behind for the configured
 * modes, ensures each has a JUnit sibling (converting only when Unity produced
 * none, or produced an empty one, per D8) and refreshes `summary.json`.
 *
 * The paths are the ones `run test` uses (Task 9), so the two commands agree on
 * where a report lives: `<test.outputDir>/<mode>.xml` is the input and
 * `<test.outputDir>/<mode>.junit.xml` is the output. Only the configured modes
 * are read — never every `*.xml` in the directory, which would count stale or
 * unrelated files. The NUnit file is read only, never rewritten.
 *
 * The command owns the verdict, and the verdict is its exit code:
 *
 * - 0 `passed` — every configured mode's report parsed and no test failed;
 * - 8 `tests_failed` — a report shows a failure;
 * - 65 `infra_failed` — a report exists but cannot be parsed (GC7);
 * - 6 `infra_failed` — no configured mode produced a usable report (R18).
 *
 * `summary.json` is written on every path, including the failures, so a stale
 * green summary is never left behind.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { nunitToJUnit } from '../report/junit.js';
import { ReportParseError, parseNUnitReport, type TestCounts } from '../report/nunit.js';
import {
  buildSummary,
  deriveStatus,
  writeSummary,
  type Summary,
} from '../report/summary.js';

/** A report path relative to the output directory, with forward slashes. */
function reportPath(outputDir: string, file: string): string {
  const relativePath = relative(outputDir, file);
  const value =
    relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)
      ? file
      : relativePath;
  return value.split(sep).join('/');
}

/**
 * True for an existing, non-empty regular file. R18: an empty artifact is not
 * a produced artifact, so it must not be published as one.
 */
function isNonEmptyFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * The Editor version recorded in the summary: the configured value, or the one
 * pinned in `ProjectSettings/ProjectVersion.txt` when it is `from-project`.
 */
function resolveEditorVersion(ctx: CoreContext): string {
  const configured = ctx.config.unity.editor.version;
  if (configured !== 'from-project') return configured;
  try {
    const text = readFileSync(
      resolve(ctx.projectPath, 'ProjectSettings', 'ProjectVersion.txt'),
      'utf8',
    );
    const match = /^m_EditorVersion:\s*(\S+)/m.exec(text);
    return match?.[1] ?? '';
  } catch {
    // The summary is still useful without it; `setup` reports a missing
    // ProjectVersion.txt long before this command runs.
    return '';
  }
}

/** A previous summary is a starting point, not a requirement. */
function readPreviousSummary(path: string): Summary | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === 1
    ) {
      return parsed as Summary;
    }
  } catch {
    // Missing, unreadable or corrupt: rebuild it from the reports.
  }
  return undefined;
}

/** Masks every string that reaches summary.json (GC5). */
function redactSummary(ctx: CoreContext, summary: Summary): Summary {
  const redact = (value: string): string => ctx.redactor.redact(value);
  const optional = (value: string | null): string | null =>
    value === null ? null : redact(value);
  return {
    ...summary,
    cliVersion: redact(summary.cliVersion),
    cliChannel: optional(summary.cliChannel),
    cliCommit: optional(summary.cliCommit),
    editorVersion: redact(summary.editorVersion),
    reports: {
      nunit: summary.reports.nunit.map(redact),
      junit: summary.reports.junit.map(redact),
    },
    license: { ...summary.license, mode: redact(summary.license.mode) },
    artifacts: summary.artifacts.map(redact),
    logs: {
      editor: optional(summary.logs.editor),
      cli: optional(summary.logs.cli),
    },
  };
}

function addCounts(into: TestCounts, from: TestCounts): void {
  into.total += from.total;
  into.passed += from.passed;
  into.failed += from.failed;
  into.skipped += from.skipped;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function reportCommand(ctx: CoreContext): Promise<number> {
  const testDir = resolve(ctx.projectPath, ctx.config.test.outputDir);
  const outputDir = resolve(ctx.projectPath, ctx.config.output.dir);
  // A repeated mode would run (and count) the same report twice.
  const modes = [...new Set(ctx.config.test.modes)];
  if (modes.length === 0) {
    ctx.logger.error('test.modes is empty; no report can be verified.');
  }

  const counts: TestCounts = { total: 0, passed: 0, failed: 0, skipped: 0 };
  const nunitReports: string[] = [];
  const junitReports: string[] = [];
  const missingModes: string[] = [];
  let reportFailed = false;

  for (const mode of modes) {
    const nunitFile = join(testDir, `${mode}.xml`);
    const junitFile = join(testDir, `${mode}.junit.xml`);

    // R18: an NUnit report must exist and be non-empty. A missing or empty one
    // means this mode produced nothing usable.
    if (!isNonEmptyFile(nunitFile)) {
      missingModes.push(mode);
      if (isNonEmptyFile(junitFile)) junitReports.push(reportPath(outputDir, junitFile));
      ctx.logger.error(`no NUnit report for mode ${mode} at ${nunitFile}.`);
      continue;
    }

    let xml: string;
    try {
      xml = readFileSync(nunitFile, 'utf8');
    } catch (error) {
      reportFailed = true;
      ctx.logger.error(`could not read the ${mode} report at ${nunitFile}: ${describe(error)}`);
      continue;
    }

    try {
      const report = parseNUnitReport(xml);
      addCounts(counts, report.counts);
    } catch (error) {
      reportFailed = true;
      if (error instanceof ReportParseError) {
        ctx.logger.error(`could not parse the ${mode} report at ${nunitFile}: ${error.message}`);
      } else {
        ctx.logger.error(`could not parse the ${mode} report at ${nunitFile}: ${describe(error)}`);
      }
      continue;
    }

    nunitReports.push(reportPath(outputDir, nunitFile));

    // D8: a non-empty JUnit file is Unity's and is authoritative. A missing or
    // empty sibling means Unity produced none, so the core converts its NUnit
    // report. Redaction happens here, at the boundary where bytes reach the
    // filesystem (GC5): the JUnit file is an uploaded CI artifact.
    if (!isNonEmptyFile(junitFile)) {
      try {
        writeFileSync(junitFile, ctx.redactor.redact(nunitToJUnit(xml)), 'utf8');
      } catch (error) {
        reportFailed = true;
        ctx.logger.error(`could not write the JUnit report at ${junitFile}: ${describe(error)}`);
      }
    }
    if (isNonEmptyFile(junitFile)) junitReports.push(reportPath(outputDir, junitFile));
  }

  // The verdict is the exit code (and the summary status is derived from it).
  // A parse/write failure outranks a red suite; a red suite outranks a mode
  // that produced no report at all.
  const exitCode =
    reportFailed === true
      ? EXIT.INTERNAL_ERROR
      : counts.failed > 0
        ? EXIT.TESTS_FAILED
        : missingModes.length > 0 || modes.length === 0
          ? EXIT.COMMAND_FAILED
          : EXIT.SUCCESS;

  const previous = readPreviousSummary(join(outputDir, 'summary.json'));
  const summary = buildSummary({
    ...(previous ?? {}),
    command: 'test',
    status: deriveStatus(exitCode),
    exitCode,
    unityExitCode: previous?.unityExitCode ?? exitCode,
    attempts: previous?.attempts ?? 1,
    cliVersion: ctx.cliVersion ?? previous?.cliVersion ?? '',
    cliChannel: ctx.cliChannel ?? previous?.cliChannel ?? null,
    cliCommit: ctx.cliCommit ?? previous?.cliCommit ?? null,
    editorVersion: previous?.editorVersion || resolveEditorVersion(ctx),
    durationMs: previous?.durationMs ?? Date.now() - ctx.startedAt,
    tests: counts,
    reports: { nunit: nunitReports, junit: junitReports },
    license: previous?.license ?? {
      mode: ctx.config.license.mode,
      activated: false,
      returned: false,
      seatLeaked: false,
    },
    artifacts: previous?.artifacts ?? [],
    logs: previous?.logs ?? { editor: null, cli: null },
  });

  try {
    // Written on every path, including 6/8/65, so a stale green summary can
    // never survive a failed report.
    writeSummary(outputDir, redactSummary(ctx, summary));
  } catch (error) {
    ctx.logger.error(`could not write summary.json under ${outputDir}: ${describe(error)}`);
    return EXIT.INTERNAL_ERROR;
  }

  ctx.logger.info(
    `report status ${summary.status} (exit ${exitCode}); refreshed ${nunitReports.length} test report pair${nunitReports.length === 1 ? '' : 's'} and ${join(outputDir, 'summary.json')}.`,
  );
  return exitCode;
}
