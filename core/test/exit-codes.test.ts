import { describe, expect, it } from 'vitest';
import { EXIT, describeExit } from '../src/exit-codes.js';

describe('EXIT', () => {
  it('carries the stable 1.0.x table added after beta.17', () => {
    expect(EXIT.RUN_FAILED).toBe(15);
    expect(EXIT.JOB_SUSPENDED).toBe(16);
    expect(EXIT.UNAVAILABLE).toBe(17);
    expect(EXIT.AWAITING_INPUT).toBe(18);
    expect(EXIT.OUTPUT_CLOSED).toBe(141);
  });

  it('does not renumber the codes the toolkit already used', () => {
    expect(EXIT.SUCCESS).toBe(0);
    expect(EXIT.BAD_ARGS).toBe(2);
    expect(EXIT.COMMAND_FAILED).toBe(6);
    expect(EXIT.NETWORK_UNREACHABLE).toBe(7);
    expect(EXIT.TESTS_FAILED).toBe(8);
    expect(EXIT.NOT_FOUND).toBe(11);
    expect(EXIT.EDITOR_UNREACHABLE).toBe(12);
    expect(EXIT.TIMEOUT).toBe(14);
    expect(EXIT.CONFIG_ERROR).toBe(64);
    expect(EXIT.INTERNAL_ERROR).toBe(65);
    expect(EXIT.INTERRUPTED).toBe(130);
    expect(EXIT.TERMINATED).toBe(143);
  });

  it('describes the new codes for logs and failure messages', () => {
    expect(describeExit(EXIT.RUN_FAILED)).toContain('run failed');
    expect(describeExit(EXIT.JOB_SUSPENDED)).toContain('suspended');
    expect(describeExit(EXIT.UNAVAILABLE)).toContain('unavailable');
    expect(describeExit(EXIT.AWAITING_INPUT)).toContain('input');
    expect(describeExit(EXIT.OUTPUT_CLOSED)).toContain('output');
  });
});
