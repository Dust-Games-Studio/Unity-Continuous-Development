import { spawn } from 'node:child_process';
import { EXIT } from './exit-codes.js';
import type { Logger } from './logger.js';
import type { Redactor } from './redact.js';

/** What a finished child process produced. Both streams are already redacted. */
export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
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
 * redacted before they are returned.
 *
 * A timeout kills the child (SIGTERM, then SIGKILL) and resolves with
 * `EXIT.TIMEOUT` instead of rejecting, so callers branch on the exit code the
 * same way they do for a real Unity exit.
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
      });
    };

    /**
     * Logs complete lines as they arrive and keeps the unterminated tail, so an
     * incomplete line is never logged twice (or in two pieces).
     */
    const consume = (chunk: Buffer | string, level: 'debug' | 'warn', tail: Tail): void => {
      tail.value += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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
    });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.value += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      consume(chunk, 'debug', stdoutTail);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.value += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      consume(chunk, 'warn', stderrTail);
    });

    child.on('error', (error: Error) => {
      // A binary that cannot be started never emits `close`; resolve here so a
      // caller can report it instead of hanging.
      stderr.value += `${error.message}\n`;
      opts.logger.error(`failed to start ${opts.file}: ${error.message}`);
      settle(EXIT.COMMAND_FAILED);
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
        opts.logger.warn(`child ${opts.file} timed out after ${timeoutMs} ms`);
        child.kill('SIGTERM');
        escalate = setTimeout(() => {
          child.kill('SIGKILL');
          rescue = setTimeout(() => settle(EXIT.TIMEOUT), SIGKILL_GRACE_MS);
        }, SIGTERM_GRACE_MS);
      }, timeoutMs);
    }
  });
}
