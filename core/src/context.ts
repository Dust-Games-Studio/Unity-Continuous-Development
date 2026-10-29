import type { Config } from './config/schema.js';
import type { Logger } from './logger.js';
import type { Redactor } from './redact.js';

/**
 * Everything a command needs. Built once by the CLI entrypoint from the loaded
 * configuration plus the process environment.
 */
export interface CoreContext {
  config: Config;
  /** The directory the command was invoked from. */
  cwd: string;
  /** The Unity project root: `--project-path`, else `cwd`. */
  projectPath: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  redactor: Redactor;
  /** The Unity CLI binary to spawn (`unity.cli.binary`). */
  binary: string;
  /**
   * True once this process has activated a licence seat, so the teardown may
   * return it. Absent (or `false`) means no seat was taken: `returnLicense` is
   * then a no-op instead of returning whatever licence the machine already had
   * (for example a developer's own personal licence under `license.mode: none`).
   *
   * Optional so a caller that never touches licensing (a report-only command, a
   * test fixture) does not have to state it; absent is read as `false` and the
   * gate therefore fails closed.
   */
  licenseActivated?: boolean;
  /** Milliseconds since the epoch, for duration reporting. */
  startedAt: number;
  /**
   * The running Unity CLI's identity, filled in by `setup` (and `doctor`) from
   * `unity version --format json`. `summary.json` records all three so a
   * failure can be traced to an exact CLI build (R16).
   */
  cliVersion: string | null;
  cliChannel: string | null;
  cliCommit: string | null;
}
