import { describe, it, expect } from 'vitest';
import { createRedactor } from '../src/redact.js';

describe('createRedactor', () => {
  it('replaces a registered secret with ***', () => {
    const r = createRedactor();
    r.register('s3cret');
    expect(r.redact('token=s3cret end')).toBe('token=*** end');
  });
  it('ignores empty, null and undefined registrations', () => {
    const r = createRedactor();
    r.register(''); r.register(null); r.register(undefined);
    expect(r.redact('nothing to hide')).toBe('nothing to hide');
  });
  it('never replaces an empty string, which would match everywhere', () => {
    const r = createRedactor();
    r.register('');
    expect(r.redact('abc')).toBe('abc');
  });
  it('registers a secret added after the first redact call', () => {
    const r = createRedactor();
    r.redact('x');
    r.register('late');
    expect(r.redact('late')).toBe('***');
  });
});
