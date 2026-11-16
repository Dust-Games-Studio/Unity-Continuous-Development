import { describe, expect, it } from 'vitest';
import { listingRows } from '../src/unity/listings.js';

describe('listingRows', () => {
  it('reads the 1.0.x listing envelope from data.items', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(listingRows({ items: rows, total: 2, nextPage: null, partial: false }, ['editors'])).toEqual(rows);
  });

  it('reads a bare array, the pre-1.0 shape', () => {
    const rows = [{ id: 'a' }];
    expect(listingRows(rows, ['editors'])).toEqual(rows);
  });

  it('reads a legacy named key when there is no items array', () => {
    const rows = [{ id: 'a' }];
    expect(listingRows({ editors: rows }, ['editors'])).toEqual(rows);
  });

  it('prefers items over a legacy key when both are present', () => {
    expect(listingRows({ items: [1], editors: [2] }, ['editors'])).toEqual([1]);
  });

  it('returns an empty list for a missing or null data document', () => {
    expect(listingRows(null, ['editors'])).toEqual([]);
    expect(listingRows(undefined, ['editors'])).toEqual([]);
    expect(listingRows({}, ['editors'])).toEqual([]);
  });

  it('ignores a non-array items value and falls back to the legacy key', () => {
    expect(listingRows({ items: 'nope', editors: [{ id: 'a' }] }, ['editors'])).toEqual([
      { id: 'a' },
    ]);
  });
});
