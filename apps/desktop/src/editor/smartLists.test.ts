import { describe, it, expect } from 'vitest';
import { listContinuation } from './smartLists';

describe('listContinuation', () => {
  it('continues an unordered item, preserving indent', () => {
    expect(listContinuation('  - hello')).toEqual({ kind: 'continue', insert: '  - ' });
    expect(listContinuation('* world')).toEqual({ kind: 'continue', insert: '* ' });
    expect(listContinuation('+ plus')).toEqual({ kind: 'continue', insert: '+ ' });
  });

  it('increments an ordered item, preserving indent', () => {
    expect(listContinuation('3. third')).toEqual({ kind: 'continue', insert: '4. ' });
    expect(listContinuation('  10. ten')).toEqual({ kind: 'continue', insert: '  11. ' });
  });

  it('clears an empty item (exit the list)', () => {
    expect(listContinuation('- ')).toEqual({ kind: 'clear' });
    expect(listContinuation('  1. ')).toEqual({ kind: 'clear' });
  });

  it('returns null for a non-list line', () => {
    expect(listContinuation('plain text')).toBeNull();
    expect(listContinuation('# heading')).toBeNull();
    expect(listContinuation('')).toBeNull();
  });
});
