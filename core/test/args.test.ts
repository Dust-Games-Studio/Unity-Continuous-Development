import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('splits a command path from its flags', () => {
    const r = parseArgs(['run', 'test', '--project-path', 'C:/p', '--ci']);
    expect(r.command).toEqual(['run', 'test']);
    expect(r.flags['project-path']).toBe('C:/p');
    expect(r.flags.ci).toBe(true);
  });
  it('collects a repeated flag into an array', () => {
    const r = parseArgs(['run', 'test', '--mode', 'EditMode', '--mode', 'PlayMode']);
    expect(r.flags.mode).toEqual(['EditMode', 'PlayMode']);
  });
  it('supports --flag=value form', () => {
    expect(parseArgs(['run', '--output-dir=ci-out']).flags['output-dir']).toBe('ci-out');
  });
  it('treats an unknown flag as a usage error', () => {
    expect(() => parseArgs(['run', '--nope'])).toThrow(/nope/);
  });
});
