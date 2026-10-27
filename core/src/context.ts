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
