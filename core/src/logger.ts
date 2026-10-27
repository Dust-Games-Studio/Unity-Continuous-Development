import type { Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface LoggerOptions {
  redactor: Redactor;
  level?: LogLevel;
  sink?: (line: string) => void;
}

const RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * A line-oriented logger. Every line is passed through the redactor first, so
 * a secret can never reach the sink even if it is interpolated into a message.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const level = opts.level ?? 'info';
  const sink = opts.sink ?? ((line: string): void => { process.stdout.write(line); });
  const minimum = RANK[level];

  const write = (messageLevel: LogLevel, msg: string): void => {
    if (RANK[messageLevel] < minimum) return;
    sink(`${opts.redactor.redact(msg)}\n`);
  };

  return {
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    // Debug output is opt-in: it is a no-op at every other level.
    debug: (msg) => write('debug', msg),
  };
}
