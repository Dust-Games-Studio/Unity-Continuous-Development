import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(line);
    },
  };
}

describe('createLogger', () => {
  it('writes one newline-terminated line per message to the sink', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: createRedactor(), sink });

    logger.info('first');
    logger.warn('second');

    expect(lines).toEqual(['first\n', 'second\n']);
  });

  it('redacts a registered secret before writing the line', () => {
    const { lines, sink } = capture();
    const redactor = createRedactor();
    redactor.register('s3cret');
    const logger = createLogger({ redactor, sink });

    logger.info('token=s3cret');

    expect(lines).toEqual(['token=***\n']);
    expect(lines.join('')).not.toContain('s3cret');
  });

  it('redacts a secret registered after the logger was created', () => {
    const { lines, sink } = capture();
    const redactor = createRedactor();
    const logger = createLogger({ redactor, sink });

    logger.info('before');
    redactor.register('late-secret');
    logger.info('after late-secret');

    expect(lines).toEqual(['before\n', 'after ***\n']);
  });

  it('suppresses debug messages at the default level', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: createRedactor(), sink });

    logger.debug('hidden');

    expect(lines).toEqual([]);
  });

  it('emits debug messages when the level is debug', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: createRedactor(), level: 'debug', sink });

    logger.debug('shown');

    expect(lines).toEqual(['shown\n']);
  });

  it('suppresses messages below the configured level', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: createRedactor(), level: 'warn', sink });

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(lines).toEqual(['warn\n', 'error\n']);
  });
});
