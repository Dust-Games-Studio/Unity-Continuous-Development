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
    const r = parseArgs(['run', 'test', '--mode', 'EditMode', '--mode', 'PlayMode'], {
      mode: { type: 'string', multiple: true },
    });
    expect(r.flags.mode).toEqual(['EditMode', 'PlayMode']);
  });
  it('supports --flag=value form', () => {
    expect(parseArgs(['run', '--output-dir=ci-out']).flags['output-dir']).toBe('ci-out');
  });
  it('treats an unknown flag as a usage error', () => {
    expect(() => parseArgs(['run', '--nope'])).toThrow(/nope/);
  });
  it('treats a valued unknown option as a usage error', () => {
    expect(() => parseArgs(['run', '--nope', 'value'])).toThrow(/nope/);
  });
  it('parses a declared boolean without consuming the next token', () => {
    const r = parseArgs(['run', 'test', '--ci', 'EditMode']);
    expect(r.flags.ci).toBe(true);
    expect(r.command).toEqual(['run', 'test', 'EditMode']);
    expect(parseArgs(['run', 'test', '--no-ci']).flags.ci).toBe(false);
  });
  it('accepts an option declared through extraOptions', () => {
    const r = parseArgs(['run', 'test', '--filter', 'Smoke'], {
      filter: { type: 'string' },
    });
    expect(r.flags.filter).toBe('Smoke');
    expect(r.command).toEqual(['run', 'test']);
  });
  it('merges extraOptions with the global schema instead of replacing it', () => {
    const r = parseArgs(['--output-dir', 'ci-out', '--mode', 'EditMode'], { mode: { type: 'string' } });
    expect(r.flags['output-dir']).toBe('ci-out');
    expect(r.flags.mode).toBe('EditMode');
  });
  it('returns an array for a multiple option supplied once', () => {
    const r = parseArgs(['run', '--mode', 'EditMode'], { mode: { type: 'string', multiple: true } });
    expect(r.flags.mode).toEqual(['EditMode']);
  });
  it('keeps a multiple boolean option as booleans, not strings', () => {
    const r = parseArgs(['run', '--verbose', '--verbose'], { verbose: { type: 'boolean', multiple: true } });
    expect(r.flags.verbose).toEqual([true, true]);
  });
  it('omits a multiple option that was not supplied', () => {
    const r = parseArgs(['run'], { mode: { type: 'string', multiple: true } });
    expect('mode' in r.flags).toBe(false);
  });
  it('separates tokens after -- into passthrough', () => {
    const r = parseArgs(['run', 'test', '--', '-nographics']);
    expect(r.command).toEqual(['run', 'test']);
    expect(r.passthrough).toEqual(['-nographics']);
    expect(parseArgs(['run', 'test']).passthrough).toEqual([]);
  });
});
