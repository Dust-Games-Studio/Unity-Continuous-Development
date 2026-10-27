/**
 * `unityci report`: converts the NUnit reports a test run left behind into their
 * JUnit siblings and refreshes `summary.json`.
 *
 * The paths are the ones `run test` uses (Task 9), so the two commands agree on
 * where a report lives: `<test.outputDir>/<mode>.xml` is the input and
 * `<test.outputDir>/<mode>.junit.xml` is the output. The NUnit file is read
 * only, never rewritten.
 *
 * A malformed report is exit 65 (GC7): a report that cannot be read must not
 * become a silent zero-count pass.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, basename, join, relative, resolve, sep } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { nunitToJUnit } from '../report/junit.js';
import { ReportParseError, parseNUnitReport, type TestCounts } from '../report/nunit.js';
import { buildSummary, writeSummary, type Summary } from '../report/summary.js';

function isNUnitReportFile(name: string): boolean {
  return name.endsWith('.xml') && !name.endsWith('.junit.xml');
}

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

export async function reportCommand(ctx: CoreContext): Promise<number> {
  const testDir = resolve(ctx.projectPath, ctx.config.test.outputDir);
  const outputDir = resolve(ctx.projectPath, ctx.config.output.dir);

  try {
    const nunitFiles = readdirSync(testDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isNUnitReportFile(entry.name))
      .map((entry) => join(testDir, entry.name))
      .sort();

    if (nunitFiles.length === 0) {
      ctx.logger.error(`no NUnit reports found under ${testDir}; nothing to convert.`);
      return EXIT.INTERNAL_ERROR;
    }

    const counts: TestCounts = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const nunitReports: string[] = [];
    const junitReports: string[] = [];

    for (const file of nunitFiles) {
      const xml = readFileSync(file, 'utf8');
      // Parse first: a malformed file must fail before anything is written for
      // it, and before nunitToJUnit parses it a second time.
      const report = parseNUnitReport(xml);
      addCounts(counts, report.counts);

      const junitFile = join(testDir, `${basename(file, '.xml')}.junit.xml`);
      writeFileSync(junitFile, nunitToJUnit(xml), 'utf8');

      nunitReports.push(reportPath(outputDir, file));
      junitReports.push(reportPath(outputDir, junitFile));
    }

    const exitCode = counts.failed > 0 ? EXIT.TESTS_FAILED : EXIT.SUCCESS;
    const previous = readPreviousSummary(join(outputDir, 'summary.json'));
    const summary = buildSummary({
      ...(previous ?? {}),
      command: 'test',
      status: counts.failed > 0 ? 'tests_failed' : 'passed',
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

    writeSummary(outputDir, redactSummary(ctx, summary));
    ctx.logger.info(
      `converted ${nunitFiles.length} NUnit report${nunitFiles.length === 1 ? '' : 's'} to JUnit and refreshed ${join(outputDir, 'summary.json')}.`,
    );
    return EXIT.SUCCESS;
  } catch (error) {
    if (error instanceof ReportParseError) {
      ctx.logger.error(`could not parse an NUnit report: ${error.message}`);
    } else {
      const detail = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`could not convert the test reports: ${detail}`);
    }
    return EXIT.INTERNAL_ERROR;
  }
}
