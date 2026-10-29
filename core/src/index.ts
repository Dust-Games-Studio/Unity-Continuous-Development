/**
 * The public surface of the provider-neutral core.
 *
 * `main` is what the `unityci` binary calls; everything else is exported so an
 * adapter, a test or a tool can build a context or read a contract without
 * importing a private module path.
 */
export { main } from './cli.js';

export { EXIT, describeExit } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';

export { parseArgs } from './args.js';
export type { OptionSpec, ParseResult } from './args.js';

export { createLogger } from './logger.js';
export type { LogLevel, Logger, LoggerOptions } from './logger.js';

export { createRedactor } from './redact.js';
export type { Redactor } from './redact.js';

export { loadConfig } from './config/load.js';
export type { LoadConfigOptions, LoadConfigResult } from './config/load.js';
export { DEFAULT_CONFIG } from './config/schema.js';
export type { Config, ConfigIssue } from './config/schema.js';

export type { CoreContext } from './context.js';
export type { CacheInfo } from './commands/cache-info.js';
export type { Summary } from './report/summary.js';
