/**
 * The `unityci` command layer: the only module that knows the command names.
 *
 * It parses argv, loads the layered configuration, builds the {@link CoreContext}
 * and dispatches to a command module. It never spawns anything itself (GC3):
 * every child process belongs to `exec.ts`, reached through a command. It has no
 * top-level side effects; `bin.ts` is the published entrypoint.
 *
 * @see bin.ts
 *
 * Two ordering rules are load-bearing:
 *
 * 1. **Secrets are registered before the logger exists** (GC6). Every secret in
 *    the environment — including the names the configuration chooses for the
 *    licence serial and file — is in the redactor before the first line can be
 *    emitted, so no log path can leak one.
 * 2. **stdout carries only machine-readable output.** The logger writes to
 *    stderr; stdout is reserved for `--help`/`--version`, the `--json` document
 *    and the GitHub workflow commands a command may write through `ctx.stdout`.
 *    `unityci cache-info --json | jq` therefore receives a clean document.
 */
import { readFileSync } from 'node:fs';
import { parseArgs, type OptionSpec, type ParseResult } from './args.js';
import { cacheInfoCommand } from './commands/cache-info.js';
import { doctorCommand } from './commands/doctor.js';
import {
  licenseActivateCommand,
  licenseReturnCommand,
} from './commands/license.js';
import { reportCommand } from './commands/report.js';
import { runCommand } from './commands/run.js';
import { setupCommand } from './commands/setup.js';
import { loadConfig } from './config/load.js';
import { validateConfig } from './config/validate.js';
import type { CoreContext } from './context.js';
import { EXIT } from './exit-codes.js';
import { returnLicense } from './lifecycle/license.js';
import { checkLicense } from './lifecycle/setup.js';
import {
  SIGNAL_LICENSE_RETURN_TIMEOUT_MS,
  createSignalTeardown,
  installSignalHandlers,
} from './lifecycle/signals.js';
import { createLogger, type LogLevel, type Logger } from './logger.js';
import { createRedactor, type Redactor } from './redact.js';

/** Flags every command accepts; the parser's own `GLOBAL_OPTIONS` mirrors this. */
const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  'project-path',
  'config',
  'output-dir',
  'annotations',
  'ci',
  'verbose',
  'quiet',
  'help',
  'version',
]);

/**
 * The union of every command-specific option. Declaring the union keeps the
 * parser strict (an undeclared option is always a usage error); the command
 * shape check below then rejects an option on a command that does not use it.
 */
const EXTRA_OPTIONS = {
  'required-module': { type: 'string', multiple: true },
} as const satisfies Record<string, OptionSpec>;

/** The command-specific options each command actually accepts. */
const COMMAND_EXTRA_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  setup: new Set(['required-module']),
  // `--json` is meaningful only where a command emits a machine document.
  'cache-info': new Set(['json']),
};

const LICENSE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'activate',
  'return',
  'status',
]);

const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  'doctor',
  'setup',
  'license',
  'run',
  'report',
  'cache-info',
]);

/**
 * Secrets that are always environment-only. A licence's own variable names are
 * configurable, so the resolved names are registered after the configuration is
 * loaded — still before the first log line.
 */
const DEFAULT_SECRET_NAMES = [
  'UNITY_SERVICE_ACCOUNT_ID',
  'UNITY_SERVICE_ACCOUNT_SECRET',
  'UNITY_LICENSE_SERIAL',
  'UNITY_LICENSE_FILE_BASE64',
] as const;

/** The `UNITYCI_SECRET_*` prefix registers an arbitrary provider secret. */
const SECRET_PREFIX = 'UNITYCI_SECRET_';

const USAGE = `Usage: unityci <command> [options]

Commands:
  doctor                    Run the preflight checks
  setup                     Verify or install the Unity Editor
  license activate          Activate a Unity license
  license return            Return the Unity license seat
  license status            Report the Unity license state
  run test                  Run Unity tests through the full lifecycle
  run build                 Build the project through the full lifecycle
  report                    Verify test reports and refresh summary.json
  cache-info                Print cache descriptors (--json for a machine document)

Global options:
  -p, --project-path <path>  The Unity project root (default: current directory)
      --config <file>        Explicit configuration file
      --output-dir <dir>     Override output.dir
      --annotations <mode>   none | github
      --ci / --no-ci         Override output.ci
      --verbose              Debug logging
      --quiet                Errors only
  -h, --help                 Print this help and exit
  -v, --version              Print the version and exit

Setup options:
      --required-module <id> Required Editor module (repeatable)

Cache options:
      --json                 Print the cache descriptors as JSON (cache-info)
`;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeStderr(text: string): void {
  try {
    process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  } catch {
    // A closed stderr must never turn a usage error into an internal one.
  }
}

function safeStdout(text: string): void {
  try {
    process.stdout.write(text);
  } catch {
    // The exit code is the contract; a closed stdout is not worth a crash.
  }
}

/** The logger's sink. Every human-facing line goes to stderr, never stdout. */
function stderrSink(line: string): void {
  safeStderr(line);
}

/** Reads the package version without importing JSON (which Node ESM forbids). */
function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version !== '') return version;
    }
  } catch {
    // Falling through to a marker is better than failing --version.
  }
  return '0.0.0';
}

/**
 * Registers a secret value and its trimmed form. A secret pasted from a CI
 * variable commonly carries a newline; Unity trims it before echoing it, so the
 * redactor must know both forms.
 */
function registerSecret(redactor: Redactor, value: string | undefined): void {
  if (value === undefined) return;
  redactor.register(value);
  redactor.register(value.trim());
}

function registerEnvironmentSecrets(
  redactor: Redactor,
  env: NodeJS.ProcessEnv,
): void {
  for (const name of DEFAULT_SECRET_NAMES) registerSecret(redactor, env[name]);
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(SECRET_PREFIX)) registerSecret(redactor, value);
  }
}

/** Registers the licence variable names the configuration selected. */
function registerConfiguredSecrets(
  redactor: Redactor,
  env: NodeJS.ProcessEnv,
  serialEnv: string,
  fileEnv: string,
): void {
  registerSecret(redactor, env[serialEnv]);
  registerSecret(redactor, env[fileEnv]);
}

function logLevel(flags: ParseResult['flags']): LogLevel {
  // Quiet wins when both are given: a caller asking for silence gets silence.
  if (flags.quiet === true) return 'error';
  if (flags.verbose === true) return 'debug';
  return 'info';
}

function usageError(redactor: Redactor, message: string): number {
  safeStderr(redactor.redact(`error: ${message}\n\n${USAGE}`));
  return EXIT.BAD_ARGS;
}

/**
 * Rejects positional arguments a command does not take. This happens before the
 * configuration is loaded, so `unityci run` is a usage error even when the
 * project has no `unity-ci.yml`.
 */
function commandProblem(command: string[]): string | null {
  const [head, sub, ...rest] = command;
  if (head === undefined) return 'no command given';

  if (head === 'license') {
    if (sub === undefined) return 'license requires one of activate, return, status';
    if (!LICENSE_SUBCOMMANDS.has(sub)) return `unknown license command "${sub}"`;
    if (rest.length > 0) return `unexpected argument "${rest[0]}"`;
    return null;
  }

  if (head === 'run') {
    if (sub === undefined) return 'run requires one of test, build';
    if (sub !== 'test' && sub !== 'build') return `unknown run command "${sub}"`;
    if (rest.length > 0) return `unexpected argument "${rest[0]}"`;
    return null;
  }

  if (sub !== undefined) return `unexpected argument "${sub}" for ${head}`;
  return null;
}

/** Rejects a command-specific option on a command that does not accept it. */
function flagProblem(
  head: string,
  flags: ParseResult['flags'],
): string | null {
  const extra = COMMAND_EXTRA_FLAGS[head] ?? new Set<string>();
  for (const name of Object.keys(flags)) {
    if (GLOBAL_FLAGS.has(name) || extra.has(name)) continue;
    return `option --${name} is not valid for ${head}`;
  }
  return null;
}

function requiredModulesFrom(
  flags: ParseResult['flags'],
): string[] | undefined {
  const value = flags['required-module'];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string' && value !== '') return [value];
  return undefined;
}

/**
 * The signal teardown for `license activate`: there is no run summary to write,
 * so this is licence-only, but it gets the same 45 s budget as the run path so a
 * hung licensing service cannot hold the exit open. `force: true` is correct
 * here because this process is the one that just took the seat.
 */
async function returnSeatAfterSignal(ctx: CoreContext): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      returnLicense(ctx, { force: true }).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          try {
            ctx.logger.warn(
              `the license return did not finish within ${SIGNAL_LICENSE_RETURN_TIMEOUT_MS} ms; exiting anyway. The seat may still be held.`,
            );
          } catch {
            // Losing a line must never prevent the exit.
          }
          resolve();
        }, SIGNAL_LICENSE_RETURN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    try {
      ctx.logger.error(
        `the license return failed after a signal: ${describe(error)}. The seat may still be held.`,
      );
    } catch {
      // The handler still exits with the signal's code.
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `unityci license status`: reports the state without deciding policy. An
 * inactive licence is reported, not failed: the run lifecycle activates it in
 * an activation mode. A CLI that does not know `license status` cannot answer
 * the precondition at all, so that is a configuration error.
 */
async function licenseStatus(ctx: CoreContext): Promise<number> {
  const status = await checkLicense(ctx);
  if (status.unsupported) {
    ctx.logger.error(
      'this Unity CLI does not support `license status`; the licence state cannot be read.',
    );
    return EXIT.CONFIG_ERROR;
  }

  ctx.logger.info(
    status.active
      ? `license active: ${status.detail}`
      : `license inactive: ${status.detail} (license.mode: ${ctx.config.license.mode})`,
  );
  if (status.floatingServer !== null) {
    ctx.logger.info(`floating license server: ${status.floatingServer}`);
  }
  return EXIT.SUCCESS;
}

async function dispatch(
  ctx: CoreContext,
  command: string[],
  flags: ParseResult['flags'],
): Promise<number> {
  const [head, sub] = command;

  switch (head) {
    case 'doctor':
      return doctorCommand(ctx);

    case 'setup': {
      const requiredModules = requiredModulesFrom(flags);
      return setupCommand(
        ctx,
        requiredModules === undefined ? {} : { requiredModules },
      );
    }

    case 'license': {
      if (sub === 'activate') {
        // `license activate` takes a seat of its own. The signal path is
        // licence-only (no summary exists) and still bounded by the same 45 s
        // budget, so an interrupt cannot leak the seat.
        const handlers = installSignalHandlers(ctx, () =>
          returnSeatAfterSignal(ctx),
        );
        try {
          return await licenseActivateCommand(ctx);
        } finally {
          handlers.dispose();
        }
      }
      if (sub === 'return') return licenseReturnCommand(ctx);
      return licenseStatus(ctx);
    }

    case 'run': {
      // The run lifecycle is the only path that holds a licence seat and writes
      // a summary, so it is the one that installs the signal handlers. They are
      // disposed in the `finally` even when the command returns normally.
      const runSub = sub === 'build' ? 'build' : 'test';
      const handlers = installSignalHandlers(
        ctx,
        createSignalTeardown(ctx, runSub),
      );
      try {
        return await runCommand(ctx, runSub);
      } finally {
        handlers.dispose();
      }
    }

    case 'report':
      return reportCommand(ctx);

    case 'cache-info':
      return cacheInfoCommand(ctx, { json: flags.json === true });

    default:
      // Unreachable: `commandProblem` rejected every other head.
      return EXIT.BAD_ARGS;
  }
}

/**
 * Parses argv, loads the configuration, builds the context and runs one
 * command. It returns the exit code and **never** calls `process.exit`: the bin
 * assigns it to `process.exitCode` so pending asynchronous work can drain.
 *
 * It never throws either. A usage error is 2, a configuration problem 64 and
 * anything unexpected 65 with a redacted message.
 */
export async function main(argv: string[]): Promise<number> {
  const startedAt = Date.now();
  const cwd = process.cwd();
  const redactor = createRedactor();
  registerEnvironmentSecrets(redactor, process.env);

  // A fallback logger exists only so the catch block has somewhere to write.
  let logger: Logger = createLogger({
    redactor,
    level: 'info',
    sink: stderrSink,
  });

  try {
    let parsed: ParseResult;
    try {
      parsed = parseArgs(argv, EXTRA_OPTIONS);
    } catch (error) {
      return usageError(redactor, describe(error));
    }

    if (parsed.flags.help === true) {
      safeStdout(USAGE);
      return EXIT.SUCCESS;
    }
    if (parsed.flags.version === true) {
      safeStdout(`${packageVersion()}\n`);
      return EXIT.SUCCESS;
    }

    // A silent drop of editor arguments is worse than refusing them. Forwarding
    // is a per-command feature (`unity test` after `--`, `unity build` through
    // one shell-split `--args` string), deferred beyond M1-M3.
    if (parsed.passthrough.length > 0) {
      return usageError(
        redactor,
        'editor arguments after -- are not forwarded yet; test.nographics covers the common case',
      );
    }

    const head = parsed.command[0];
    if (head === undefined || !KNOWN_COMMANDS.has(head)) {
      return usageError(
        redactor,
        head === undefined ? 'no command given' : `unknown command "${head}"`,
      );
    }

    const positionalProblem = commandProblem(parsed.command);
    if (positionalProblem !== null) {
      return usageError(redactor, positionalProblem);
    }

    const optionProblem = flagProblem(head, parsed.flags);
    if (optionProblem !== null) {
      return usageError(redactor, optionProblem);
    }

    const loaded = loadConfig({
      projectPath:
        typeof parsed.flags['project-path'] === 'string'
          ? parsed.flags['project-path']
          : '.',
      cwd,
      argv: parsed.flags,
      env: process.env,
      ...(typeof parsed.flags.config === 'string'
        ? { configFile: parsed.flags.config }
        : {}),
    });

    // Still before the first log line: the configuration may have renamed the
    // licence secret variables, and the resolved values must be redacted too.
    registerConfiguredSecrets(
      redactor,
      process.env,
      loaded.config.license.serialEnv,
      loaded.config.license.fileEnv,
    );

    logger = createLogger({
      redactor,
      level: logLevel(parsed.flags),
      sink: stderrSink,
    });

    for (const warning of loaded.warnings) logger.warn(warning);
    for (const name of loaded.unknownEnvVars) {
      logger.warn(`ignoring unknown environment variable ${name}`);
    }
    if (loaded.issues.length > 0) {
      // A `run` whose only problem is configuration validation is dispatched so
      // `runCommand` can write the `config_error` summary (decision 6) before
      // returning 64. Every other case — including a missing `--config` file or
      // a secret in the file, which a re-validation could not reproduce — is a
      // configuration error here and nothing is spawned.
      const validationOnly =
        head === 'run' &&
        validateConfig(loaded.config, loaded.projectPath).length ===
          loaded.issues.length;
      if (!validationOnly) {
        for (const issue of loaded.issues) {
          logger.error(`${issue.path}: ${issue.message}`);
        }
        return EXIT.CONFIG_ERROR;
      }
    }

    const ctx: CoreContext = {
      config: loaded.config,
      cwd,
      projectPath: loaded.projectPath,
      env: process.env,
      logger,
      redactor,
      stdout: (text: string): void => safeStdout(text),
      binary: loaded.config.unity.cli.binary,
      licenseActivated: false,
      startedAt,
      cliVersion: null,
      cliChannel: null,
      cliCommit: null,
    };

    return await dispatch(ctx, parsed.command, parsed.flags);
  } catch (error) {
    const message = `unexpected error: ${describe(error)}`;
    try {
      logger.error(message);
    } catch {
      safeStderr(redactor.redact(message));
    }
    return EXIT.INTERNAL_ERROR;
  }
}
