import { spawn, type ChildProcess } from 'node:child_process';
import { EXIT } from './exit-codes.js';
import type { Logger } from './logger.js';
import type { Redactor } from './redact.js';

/** What a finished child process produced. */
export interface SpawnResult {
  code: number;
  /** Redacted stdout: safe to log or persist. */
  stdout: string;
  /** Redacted stderr: safe to log or persist. */
  stderr: string;
  /**
   * Unredacted stdout. It exists only so the core can parse a machine-readable
   * document before masking it — never log, print or persist this field.
   */
  rawStdout: string;
  /** Unredacted stderr. Never log, print or persist this field. */
  rawStderr: string;
}

export interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  redactor: Redactor;
  /** Kill the child and resolve with `EXIT.TIMEOUT` after this many milliseconds. */
  timeoutMs?: number;
}

/** How long a child gets to honour SIGTERM before it is killed outright. */
const SIGTERM_GRACE_MS = 2000;
/** Last resort: resolve even if `close` never arrives after SIGKILL. */
const SIGKILL_GRACE_MS = 1000;

function signalExit(signal: NodeJS.Signals | null): number {
  switch (signal) {
    case 'SIGINT':
      return EXIT.INTERRUPTED;
    case 'SIGTERM':
      return EXIT.TERMINATED;
    default:
      return EXIT.ERROR;
  }
}

/**
 * Kills the whole tree, not just the direct child. A timed-out `unity` leaves
 * an Editor grandchild behind otherwise, holding the project's `Library/` lock
 * and its licence seat.
 *
 * POSIX: the child is spawned `detached`, so it leads its own process group;
 * a negative pid signals the group. Windows: `taskkill /T /F` walks the tree.
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      // If taskkill itself cannot start, fall back to the direct child so the
      // timeout still terminates something.
      killer.on('error', () => {
        child.kill();
      });
      killer.unref();
    } catch {
      child.kill();
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // No process group (or it is already gone): target the direct child.
    child.kill(signal);
  }
}

/** A stream's unterminated tail, carried across data chunks. */
interface Tail {
  value: string;
}

/**
 * The one and only place the toolkit starts a child process.
 *
 * The child is always given an argv array and `shell: false`, so no shell ever
 * sees a token: a space, a quote or a `;` in an argument stays part of that
 * argument. stdout and stderr are streamed to the logger line by line and
 * redacted before they are logged and before they are returned.
 *
 * A timeout kills the whole process tree (SIGTERM, then SIGKILL) and resolves
 * with `EXIT.TIMEOUT` instead of rejecting, so callers branch on the exit code
 * the same way they do for a real Unity exit.
 */
export function spawnProcess(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const stdout: Tail = { value: '' };
    const stderr: Tail = { value: '' };
    const stdoutTail: Tail = { value: '' };
    const stderrTail: Tail = { value: '' };
    let settled = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let escalate: NodeJS.Timeout | undefined;
    let rescue: NodeJS.Timeout | undefined;

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalate) clearTimeout(escalate);
      if (rescue) clearTimeout(rescue);
      resolve({
        code,
        stdout: opts.redactor.redact(stdout.value),
        stderr: opts.redactor.redact(stderr.value),
        // Parsing reads these, never the masked strings above: a mask that
        // happens to straddle JSON syntax must not turn a valid document into
        // `json: null`.
        rawStdout: stdout.value,
        rawStderr: stderr.value,
      });
    };

    /**
     * Logs complete lines as they arrive and keeps the unterminated tail, so an
     * incomplete line is never logged twice (or in two pieces).
     */
    const consume = (chunk: string, level: 'debug' | 'warn', tail: Tail): void => {
      tail.value += chunk;
      let newline = tail.value.indexOf('\n');
      while (newline !== -1) {
        const line = tail.value.slice(0, newline).replace(/\r$/, '');
        tail.value = tail.value.slice(newline + 1);
        // Redact here as well as in the logger: the streaming path must never
        // rely on the caller having wired the same redactor into its logger.
        const safe = opts.redactor.redact(line);
        if (level === 'debug') opts.logger.debug(safe);
        else opts.logger.warn(safe);
        newline = tail.value.indexOf('\n');
      }
    };

    const flushTails = (): void => {
      if (stdoutTail.value) {
        opts.logger.debug(opts.redactor.redact(stdoutTail.value.replace(/\r$/, '')));
      }
      if (stderrTail.value) {
        opts.logger.warn(opts.redactor.redact(stderrTail.value.replace(/\r$/, '')));
      }
      stdoutTail.value = '';
      stderrTail.value = '';
    };

    const child = spawn(opts.file, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group is what makes the POSIX tree kill possible. On
      // Windows `detached` would open a second console window; taskkill is
      // used there instead.
      detached: process.platform !== 'win32',
    });

    // Decode once, with a streaming decoder: a multi-byte character split
    // across chunks must not turn into replacement characters.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdout.value += chunk;
      consume(chunk, 'debug', stdoutTail);
    });

    child.stderr?.on('data', (chunk: string) => {
      stderr.value += chunk;
      consume(chunk, 'warn', stderrTail);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      // A binary that cannot be started never emits `close`; resolve here so a
      // caller can report it instead of hanging.
      stderr.value += `${error.message}\n`;
      opts.logger.error(
        opts.redactor.redact(`failed to start ${opts.file}: ${error.message}`),
      );
      // ENOENT means the requested executable is not there: the same "not
      // found" class as a missing project or release (11). Every other spawn
      // failure (EACCES, EMFILE, …) means the command could not run (6).
      settle(error.code === 'ENOENT' ? EXIT.NOT_FOUND : EXIT.COMMAND_FAILED);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      flushTails();
      if (timedOut) settle(EXIT.TIMEOUT);
      else settle(code ?? signalExit(signal));
    });

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      const timeoutMs = opts.timeoutMs;
      timeout = setTimeout(() => {
        timedOut = true;
        opts.logger.warn(
          opts.redactor.redact(`child ${opts.file} timed out after ${timeoutMs} ms`),
        );
        killProcessTree(child, 'SIGTERM');
        escalate = setTimeout(() => {
          killProcessTree(child, 'SIGKILL');
          rescue = setTimeout(() => settle(EXIT.TIMEOUT), SIGKILL_GRACE_MS);
        }, SIGTERM_GRACE_MS);
      }, timeoutMs);
    }
  });
}
