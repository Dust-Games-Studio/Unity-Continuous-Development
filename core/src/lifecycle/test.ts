/**
 * `run test`: the test-side hooks of the shared lifecycle.
 *
 * The sequence — `doctor` → `setup` → activate → execute → verify → `finally`
 * teardown — lives in `run-lifecycle.ts`. This module owns what is specific to
 * a test run: one `unity test` per configured mode, the retry around each
 * invocation, and the report verification.
 *
 * The artifact check is the core of the module (R18). A run that exits 0 but
 * leaves no NUnit report is **not** a green suite: `unity test --output
 * <directory>` runs the tests, exits 8 and writes no report at all, silently.
 * The same is true for a mode that exits 8 without an artifact: "the tests
 * failed" without a report is not a result anyone can act on. Both are
 * `infra_failed` (exit 6). A report that exists but cannot be parsed is exit 65
 * (GC7), never a zero-count pass.
 *
 * D8: when Unity produced no JUnit file (missing **or** empty), the core
 * converts the NUnit report and writes the `.junit.xml` through the redactor.
 * Unity's own file wins whenever it is non-empty.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { nunitToJUnit } from '../report/junit.js';
import { ReportParseError, parseNUnit, type TestCounts } from '../report/nunit.js';
import { unityTest } from '../unity/cli.js';
import {
  isNonEmptyFile,
  reportPath,
  runLifecycle,
  runWithRetry,
} from './run-lifecycle.js';
import { acceleratorArgs, editorIdentityArgs } from './editor-args.js';
import { unityBaseOptions } from './setup.js';

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
    ...editorIdentityArgs(ctx),
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
  // 1.0.x affected-test selection. `--since` is a git revision; `--affected`
  // runs the whole suite when the impact graph cannot tell.
  if (ctx.config.test.affected) args.push('--affected');
  if (ctx.config.test.since !== null) {
    args.push('--since', ctx.config.test.since);
  }
  if (ctx.config.test.affectedCompare !== null) {
    args.push('--affected-compare', ctx.config.test.affectedCompare);
  }
  // `--rerun-failed` reads the previous NUnit report at `--output`; it is
  // opt-in because a fresh runner has no previous report.
  if (ctx.config.test.rerunFailed) args.push('--rerun-failed');
  args.push(...acceleratorArgs(ctx));
  // PlayMode needs a graphics device for simulated input; -nographics is an
  // Editor argument, so it travels after the `--` separator.
  if (ctx.config.test.nographics && mode === 'EditMode') {
    args.push('--', '-nographics');
  }

  return args;
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
 * code. A Unity failure is an outcome, not a rejection (the caller needs the
 * number).
 */
async function runMode(
  ctx: CoreContext,
  mode: string,
  outputDir: string,
): Promise<ModeOutcome> {
  const nunit = join(outputDir, `${mode}.xml`);
  const junit = join(outputDir, `${mode}.junit.xml`);
  const args = testArguments(ctx, mode, outputDir);

  const run = await runWithRetry<number>(
    ctx,
    `unity test (${mode})`,
    async () => {
      const result = await unityTest(unityBaseOptions(ctx), args);
      return { value: result.code, code: result.code };
    },
    () => {
      removeReport(nunit);
      removeReport(junit);
    },
  );

  return { mode, code: run.code, attempts: run.attempts, nunit, junit };
}

/** The payload one test run's execute hands to its verify step. */
interface TestExecution {
  modes: string[];
  outcomes: ModeOutcome[];
}

/**
 * `run test`: the core run loop.
 *
 * It never throws for an expected failure: every path writes `summary.json` and
 * returns a verdict, so a stale green summary cannot survive a failed run.
 */
export async function runTest(ctx: CoreContext): Promise<TestRunResult> {
  // A repeated mode would run (and count) the same report twice.
  const modes = [...new Set(ctx.config.test.modes)];
  const outputDir = resolve(ctx.projectPath, ctx.config.test.outputDir);
  const summaryDir = resolve(ctx.projectPath, ctx.config.output.dir);

  const tests = zeroCounts();
  const nunitReports: string[] = [];
  const junitReports: string[] = [];

  const execution = await runLifecycle<TestExecution>(ctx, {
    command: 'test',
    setupOptions: { command: 'test' },
    doctorSubject: 'tests',
    execute: async (ctx) => {
      // Unity's --output is a FILE. Make sure the directory exists before the
      // first invocation; a missing report is still verified below, not assumed.
      mkdirSync(outputDir, { recursive: true });

      const outcomes: ModeOutcome[] = [];
      let unityExitCode: number = EXIT.SUCCESS;
      let attempts = 1;
      for (const mode of modes) {
        const outcome = await runMode(ctx, mode, outputDir);
        outcomes.push(outcome);
        unityExitCode = outcome.code;
        attempts = Math.max(attempts, outcome.attempts);
      }

      return {
        data: { modes, outcomes },
        unityExitCode,
        attempts,
      };
    },
    verify: async (ctx, result) => {
      if (result.data.modes.length === 0) {
        // `validateConfig` rejects an empty list; this guards a hand-built
        // context and a zero-count "pass" that no test ever produced.
        ctx.logger.error('test.modes is empty; no test invocation can run.');
        return { exitCode: EXIT.COMMAND_FAILED };
      }

      let exitCode: number = EXIT.SUCCESS;
      let rank: number = RANK.passed;
      const raise = (code: number, next: number): void => {
        if (next > rank) {
          rank = next;
          exitCode = code;
        }
      };

      for (const outcome of result.data.outcomes) {
        const { mode } = outcome;
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

        // D8: Unity's own JUnit file is authoritative only when it produced a
        // non-empty one. A missing or empty sibling is "not produced" (R18), so
        // the core converts its NUnit report. The write goes through the
        // redactor because the JUnit file is an artifact CI uploads (GC5).
        if (!hasJunit) {
          try {
            writeFileSync(outcome.junit, ctx.redactor.redact(nunitToJUnit(xml)), 'utf8');
          } catch (error) {
            ctx.logger.error(
              `could not write the ${mode} JUnit report at ${outcome.junit}: ${describe(error)}`,
            );
            raise(EXIT.INTERNAL_ERROR, RANK.internal);
          }
          if (isNonEmptyFile(outcome.junit)) {
            junitReports.push(reportPath(summaryDir, outcome.junit));
          }
        }

        if (outcome.code !== EXIT.SUCCESS && outcome.code !== EXIT.TESTS_FAILED) {
          // The invocation itself failed (11, 12, 14, …): infrastructure, even
          // if a report happened to be written.
          raise(outcome.code, RANK.infra);
        } else if (outcome.code === EXIT.TESTS_FAILED || counts.failed > 0) {
          raise(EXIT.TESTS_FAILED, RANK.testsFailed);
        }
      }

      return { exitCode };
    },
    summary: () => ({
      fields: {
        tests,
        reports: { nunit: nunitReports, junit: junitReports },
        artifacts: [],
        // `unity test` has no `--log-file`; pretending otherwise would publish
        // a path that was never written (GC10).
        logs: { editor: null, cli: null },
      },
    }),
  });

  const status: TestRunResult['status'] =
    execution.exitCode === EXIT.SUCCESS
      ? 'passed'
      : execution.exitCode === EXIT.TESTS_FAILED
        ? 'tests_failed'
        : 'infra_failed';

  return {
    status,
    exitCode: execution.exitCode,
    unityExitCode: execution.unityExitCode,
    attempts: execution.attempts,
    reports: { nunit: nunitReports, junit: junitReports },
    tests,
  };
}
