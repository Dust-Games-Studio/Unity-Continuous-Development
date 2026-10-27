/**
 * The `summary.json` contract (GC11). Adapters read this file, so a missing
 * key is a breaking change: `buildSummary` fills every documented key with a
 * default, and `writeSummary` is the only writer.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../exit-codes.js';
import type { TestCounts } from './nunit.js';

export interface Summary {
  schema: 1;
  command: 'test' | 'build';
  status: 'passed' | 'tests_failed' | 'infra_failed' | 'config_error';
  exitCode: number;
  unityExitCode: number;
  attempts: number;
  cliVersion: string;
  cliChannel: string | null;
  cliCommit: string | null;
  editorVersion: string;
  durationMs: number;
  tests: TestCounts;
  reports: { nunit: string[]; junit: string[] };
  /**
   * What the license lifecycle did. `mode` comes from the configuration,
   * `activated`/`returned` from what the lifecycle actually did, and
   * `seatLeaked` from the return result. The serial is never part of it.
   */
  license: {
    mode: string;
    activated: boolean;
    returned: boolean;
    seatLeaked: boolean;
  };
  artifacts: string[];
  logs: { editor: string | null; cli: string | null };
}

/**
 * Maps a process exit code to the summary status per GC11:
 * `0` passed, `8` tests failed, `64` configuration error, any other non-zero
 * code an infrastructure failure.
 */
export function deriveStatus(exitCode: number): Summary['status'] {
  if (exitCode === EXIT.SUCCESS) return 'passed';
  if (exitCode === EXIT.TESTS_FAILED) return 'tests_failed';
  if (exitCode === EXIT.CONFIG_ERROR) return 'config_error';
  return 'infra_failed';
}

/**
 * Fills every documented key so a partial summary can never produce a
 * `summary.json` that is missing one. Nested objects are merged key by key;
 * a caller that only knows the test counts still gets a complete `license`,
 * `reports` and `logs` object.
 */
export function buildSummary(
  partial: Partial<Summary> & Pick<Summary, 'command' | 'status' | 'exitCode'>,
): Summary {
  return {
    schema: 1,
    command: partial.command,
    status: partial.status,
    exitCode: partial.exitCode,
    unityExitCode: partial.unityExitCode ?? 0,
    attempts: partial.attempts ?? 1,
    cliVersion: partial.cliVersion ?? '',
    cliChannel: partial.cliChannel ?? null,
    cliCommit: partial.cliCommit ?? null,
    editorVersion: partial.editorVersion ?? '',
    durationMs: partial.durationMs ?? 0,
    tests: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      ...(partial.tests ?? {}),
    },
    reports: {
      nunit: [...(partial.reports?.nunit ?? [])],
      junit: [...(partial.reports?.junit ?? [])],
    },
    license: {
      mode: 'none',
      activated: false,
      returned: false,
      seatLeaked: false,
      ...(partial.license ?? {}),
    },
    artifacts: [...(partial.artifacts ?? [])],
    logs: {
      editor: null,
      cli: null,
      ...(partial.logs ?? {}),
    },
  };
}

/**
 * Writes `<outputDir>/summary.json`, creating parent directories, with 2-space
 * indentation and a trailing newline. Values must already be redacted by the
 * caller (GC5); the summary holds no free-form Unity text.
 */
export function writeSummary(outputDir: string, summary: Summary): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
}
