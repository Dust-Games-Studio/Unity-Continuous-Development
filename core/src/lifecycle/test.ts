/**
 * The test run lifecycle: `doctor` → `setup` → activate → run each configured
 * mode → verify the artifacts → `summary.json`, with an unconditional licence
 * teardown.
 *
 * The preflight comes first, as the spec's Section 4.5 orders it; `setup` then
 * verifies or installs the Editor and accepts its terms. The teardown is entered
 * on every path, including a doctor or setup failure, where it is a no-op
 * because nothing was activated.
 *
 * The artifact check is the core of the module (R18). A run that exits 0 but
 * leaves no NUnit report is **not** a green suite: `unity test --output
 * <directory>` runs the tests, exits 8 and writes no report at all, silently.
 * The same is true for a mode that exits 8 without an artifact: "the tests
 * failed" without a report is not a result anyone can act on. Both are
 * `infra_failed` (exit 6). A report that exists but cannot be parsed is exit 65
 * (GC7), never a zero-count pass.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { doctorCommand } from '../commands/doctor.js';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { ReportParseError, parseNUnit, type TestCounts } from '../report/nunit.js';
import {
  buildSummary,
  deriveStatus,
  writeSummary,
  type Summary,
} from '../report/summary.js';
import { unityTest } from '../unity/cli.js';
import {
  LicenseError,
  activateLicense,
  returnLicense,
  type LicenseActivation,
  type LicenseReturnResult,
} from './license.js';
import { withRetry } from './retry.js';
import { SetupError, setup, unityBaseOptions, type SetupResult } from './setup.js';

/**
 * The verdict of one `run test`.
 *
 * `exitCode` is additive to the brief's shape: the exit codes step 7 assigns
 * cannot be derived from `status` + `unityExitCode` alone (a missing report
 * after Unity exited 0 is exit 6 while `unityExitCode` stays the real 0; a
 * malformed report is exit 65 for the same Unity exit). `status` stays
 * three-valued because it describes the *run*: a setup, doctor or licence
 * failure is `infra_failed` here while `summary.json` records `config_error`
 * via `deriveStatus(64)`.
 */
export interface TestRunResult {
  status: 'passed' | 'tests_failed' | 'infra_failed';
  exitCode: number;
  unityExitCode: number;
  attempts: number;
  reports: { nunit: string[]; junit: string[] };
  tests: TestCounts;
}

/** Ranking for the aggregate verdict: a worse outcome is never masked. */
const RANK = {
  passed: 0,
  testsFailed: 1,
  infra: 2,
  internal: 3,
} as const;

function zeroCounts(): TestCounts {
  return { total: 0, passed: 0, failed: 0, skipped: 0 };
}

function addCounts(into: TestCounts, from: TestCounts): void {
  into.total += from.total;
  into.passed += from.passed;
  into.failed += from.failed;
  into.skipped += from.skipped;
}

/** True for an existing, non-empty regular file (R18). */
function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/**
 * Removes the report a previous attempt left behind, so the artifacts verified
 * after a retry belong to the last attempt — not to an earlier one that wrote a
 * green report and then failed the invocation. A directory is never deleted:
 * that is a configuration error the validator already rejects.
 */
function removeReport(path: string): void {
  try {
    if (!statSync(path).isFile()) return;
    rmSync(path, { force: true });
  } catch {
    // Missing (or unreadable) is the normal state before the first attempt.
  }
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One `unity test` invocation's caller-owned arguments.
 *
 * Exactly one `--mode`: the CLI accepts a repeated flag and silently lets the
 * **last one win**, so two would run one mode with no diagnostic. `--format
 * json` is appended by `unityTest` itself (GC12), never duplicated here.
 * `--allow-install` is never sent: a missing Editor must fail fast with the
 * exact install command, not download mid-run.
 */
function testArguments(ctx: CoreContext, mode: string, outputDir: string): string[] {
  const args = [
    ctx.projectPath,
    '--mode',
    mode,
    '--output',
    join(outputDir, `${mode}.xml`),
    '--report-format',
    'nunit,junit',
    '--junit-output',
    join(outputDir, `${mode}.junit.xml`),
  ];

  if (ctx.config.test.filter !== null && ctx.config.test.filter !== '') {
    args.push('--filter', ctx.config.test.filter);
  }
  if (ctx.config.test.coverage) {
    args.push('--coverage', '--coverage-output', join(outputDir, 'coverage'));
  }
  // `--shard` is `N/M` verbatim: the CLI owns the format, the core never derives
  // it.
  if (ctx.config.test.shards !== null) {
    args.push('--shard', ctx.config.test.shards);
  }
  // Unity's own per-test retries compose with the toolkit's whole-invocation
  // retry: the inner one settles a flaky test, the outer one an infrastructure
  // failure.
  if (ctx.config.test.retries > 0) {
    args.push('--retries', String(ctx.config.test.retries));
  }
  // PlayMode needs a graphics device for simulated input; -nographics is an
  // Editor argument, so it travels after the `--` separator.
  if (ctx.config.test.nographics && mode === 'EditMode') {
    args.push('--', '-nographics');
  }

  return args;
}

/** The summary with every free-form string masked before it is serialised (GC5). */
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
    tests: { ...summary.tests },
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

interface ModeOutcome {
  mode: string;
  code: number;
  attempts: number;
  nunit: string;
  junit: string;
}

/**
 * Runs one mode through the retry policy and returns the last attempt's exit
 * code. `withRetry` resolves `{ value, code }`; a Unity failure is an outcome,
 * not a rejection (the caller needs the number).
 */
async function runMode(
  ctx: CoreContext,
  mode: string,
  outputDir: string,
): Promise<ModeOutcome> {
  const nunit = join(outputDir, `${mode}.xml`);
  const junit = join(outputDir, `${mode}.junit.xml`);
  const args = testArguments(ctx, mode, outputDir);

  const run = await withRetry<number>(
    async () => {
      removeReport(nunit);
      removeReport(junit);
      const result = await unityTest(unityBaseOptions(ctx), args);
      return { value: result.code, code: result.code };
    },
    ctx.config.retry,
    (info) => {
      ctx.logger.warn(
        `unity test (${mode}) exited ${info.code} on attempt ${info.attempt}; retrying in ${info.waitMs}ms.`,
      );
    },
  );

  return { mode, code: run.code, attempts: run.attempts, nunit, junit };
}

/**
 * GC9's teardown, called from the `finally` on **every** path. The seat gate
 * lives in `returnLicense` and reads `ctx.licenseActivated`, so a signal-driven
 * teardown (Task 11), which cannot see this function's locals, inherits exactly
 * the same rule. Nothing activated (a failed doctor or setup, `license.mode:
 * none`) means nothing is returned — a developer's own personal licence must
 * never be returned as a side effect of running the toolkit locally.
 */
async function teardownLicense(ctx: CoreContext): Promise<LicenseReturnResult> {
  try {
    return await returnLicense(ctx);
  } catch (error) {
    // `returnLicense` does not throw today; a regression here must still not
    // mask the primary exit code or stop `summary.json` from being written.
    ctx.logger.error(
      `the license teardown failed: ${describe(error)}. The seat may still be held.`,
    );
    return { returned: false, code: EXIT.COMMAND_FAILED };
  }
}

/**
 * `run test`: the core run loop.
 *
 * It never throws for an expected failure: every path writes `summary.json` and
 * returns a verdict, so a stale green summary cannot survive a failed run
 * (decision 6). An unexpected exception is a bug and becomes exit 65 after the
 * teardown and the summary still run.
 */
export async function runTest(ctx: CoreContext): Promise<TestRunResult> {
  const modes = [...new Set(ctx.config.test.modes)];
  const outputDir = resolve(ctx.projectPath, ctx.config.test.outputDir);
  const summaryDir = resolve(ctx.projectPath, ctx.config.output.dir);

  let setupResult: SetupResult | null = null;
  let activation: LicenseActivation | null = null;
  let teardown: LicenseReturnResult | null = null;

  const tests = zeroCounts();
  const nunitReports: string[] = [];
  const junitReports: string[] = [];

  let exitCode: number = EXIT.SUCCESS;
  let rank: number = RANK.passed;
  let unityExitCode: number = EXIT.SUCCESS;
  let attempts = 1;

  const raise = (code: number, next: number): void => {
    if (next > rank) {
      rank = next;
      exitCode = code;
    }
  };

  try {
    // The preflight gate (R11) comes first, as the spec's Section 4.5 orders it
    // (`doctor → setup → … → license step`). `setup` deliberately does not run
    // `unity doctor --ci`; without this call the run path would never execute
    // the preflight at all.
    const doctorCode = await doctorCommand(ctx);
    if (doctorCode !== EXIT.SUCCESS) {
      ctx.logger.error(`the doctor preflight failed with exit ${doctorCode}; refusing to run the tests.`);
      exitCode = doctorCode;
    } else {
      setupResult = await setup(ctx, { command: 'test' });
      activation = await activateLicense(ctx);
      // The gate every later teardown reads — including a signal-driven one that
      // cannot see this function's locals (Task 11).
      if (activation.activated) ctx.licenseActivated = true;

      // Unity's --output is a FILE. Make sure the directory exists before the
      // first invocation; a missing report is still verified below, not assumed.
      mkdirSync(outputDir, { recursive: true });

      if (modes.length === 0) {
        // `validateConfig` rejects an empty list; this guards a hand-built
        // context and a zero-count "pass" that no test ever produced.
        ctx.logger.error('test.modes is empty; no test invocation can run.');
        raise(EXIT.COMMAND_FAILED, RANK.infra);
      }

      for (const mode of modes) {
        const outcome = await runMode(ctx, mode, outputDir);
        unityExitCode = outcome.code;
        attempts = Math.max(attempts, outcome.attempts);

        const hasNunit = isNonEmptyFile(outcome.nunit);
        const hasJunit = isNonEmptyFile(outcome.junit);
        if (hasNunit) nunitReports.push(reportPath(summaryDir, outcome.nunit));
        if (hasJunit) junitReports.push(reportPath(summaryDir, outcome.junit));

        if (!hasNunit) {
          // A mode that exited 8 "failed" without an artifact; a mode that
          // exited 0 "passed" without one. Neither is a result (R18).
          ctx.logger.error(
            `mode ${mode} produced no NUnit report at ${outcome.nunit} (unity exited ${outcome.code}); the run has no verdict.`,
          );
          const code =
            outcome.code === EXIT.SUCCESS || outcome.code === EXIT.TESTS_FAILED
              ? EXIT.COMMAND_FAILED
              : outcome.code;
          raise(code, RANK.infra);
          continue;
        }

        let xml: string;
        try {
          xml = readFileSync(outcome.nunit, 'utf8');
        } catch (error) {
          ctx.logger.error(
            `could not read the ${mode} report at ${outcome.nunit}: ${describe(error)}`,
          );
          raise(EXIT.INTERNAL_ERROR, RANK.internal);
          continue;
        }

        let counts: TestCounts;
        try {
          counts = parseNUnit(xml);
        } catch (error) {
          // GC7: a malformed report is exit 65, never a silent zero-count pass.
          const detail =
            error instanceof ReportParseError ? error.message : describe(error);
          ctx.logger.error(`could not parse the ${mode} report at ${outcome.nunit}: ${detail}`);
          raise(EXIT.INTERNAL_ERROR, RANK.internal);
          continue;
        }

        addCounts(tests, counts);

        if (outcome.code !== EXIT.SUCCESS && outcome.code !== EXIT.TESTS_FAILED) {
          // The invocation itself failed (11, 12, 14, …): infrastructure, even
          // if a report happened to be written.
          raise(outcome.code, RANK.infra);
        } else if (outcome.code === EXIT.TESTS_FAILED || counts.failed > 0) {
          raise(EXIT.TESTS_FAILED, RANK.testsFailed);
        }
      }
    }
  } catch (error) {
    if (error instanceof SetupError || error instanceof LicenseError) {
      ctx.logger.error(error.message);
      exitCode = error.exitCode;
    } else {
      ctx.logger.error(`the test run failed unexpectedly: ${describe(error)}`);
      exitCode = EXIT.INTERNAL_ERROR;
    }
  } finally {
    // GC9: the teardown is entered on every path, and its seat gate — not this
    // function's locals — decides whether anything is returned.
    teardown = await teardownLicense(ctx);

    const summary = buildSummary({
      command: 'test',
      status: deriveStatus(exitCode),
      exitCode,
      // Decision 5: the real Unity exit code of the last attempt, never a
      // second, more flattering number.
      unityExitCode,
      attempts,
      cliVersion: ctx.cliVersion ?? '',
      cliChannel: ctx.cliChannel,
      cliCommit: ctx.cliCommit,
      editorVersion:
        setupResult?.editorVersion ??
        (ctx.config.unity.editor.version === 'from-project'
          ? ''
          : ctx.config.unity.editor.version),
      durationMs: Math.max(0, Date.now() - ctx.startedAt),
      tests,
      reports: { nunit: nunitReports, junit: junitReports },
      license: {
        mode: activation?.mode ?? ctx.config.license.mode,
        activated: activation?.activated === true,
        returned: teardown?.returned === true,
        seatLeaked: teardown?.seatLeaked === true,
      },
      artifacts: [],
      // `unity test` has no `--log-file`; pretending otherwise would publish a
      // path that was never written.
      logs: { editor: null, cli: null },
    });

    try {
      writeSummary(summaryDir, redactSummary(ctx, summary));
      ctx.logger.info(
        `test status ${summary.status} (exit ${exitCode}); summary at ${join(summaryDir, 'summary.json')}.`,
      );
    } catch (error) {
      ctx.logger.error(`could not write summary.json under ${summaryDir}: ${describe(error)}`);
      exitCode = EXIT.INTERNAL_ERROR;
    }
  }

  const status: TestRunResult['status'] =
    exitCode === EXIT.SUCCESS
      ? 'passed'
      : exitCode === EXIT.TESTS_FAILED
        ? 'tests_failed'
        : 'infra_failed';

  return {
    status,
    exitCode,
    unityExitCode,
    attempts,
    reports: { nunit: nunitReports, junit: junitReports },
    tests,
  };
}
