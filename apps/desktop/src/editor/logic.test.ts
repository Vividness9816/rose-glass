import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractWikiTarget, firstNotePath, makeDebouncedSaver, shouldReloadDoc } from './logic';

describe('extractWikiTarget', () => {
  it('strips alias and heading', () => {
    expect(extractWikiTarget('a')).toBe('a');
    expect(extractWikiTarget('a|b')).toBe('a');
    expect(extractWikiTarget('a#h')).toBe('a');
    expect(extractWikiTarget('a#h|b')).toBe('a');
    expect(extractWikiTarget('  a  ')).toBe('a');
  });
});

describe('shouldReloadDoc', () => {
  const base = {
    eventPath: 'n.md',
    openPath: 'n.md',
    isDirty: false,
    lastSavedContent: 'saved',
    diskContent: 'external change',
  };
  it('reloads a clean buffer on a genuine external change', () => {
    expect(shouldReloadDoc(base)).toBe(true);
  });
  it('never reloads a different path', () => {
    expect(shouldReloadDoc({ ...base, eventPath: 'other.md' })).toBe(false);
  });
  it('never stomps unsaved edits', () => {
    expect(shouldReloadDoc({ ...base, isDirty: true })).toBe(false);
  });
  it('ignores our own save echo', () => {
    expect(shouldReloadDoc({ ...base, diskContent: 'saved' })).toBe(false);
  });
});

describe('firstNotePath', () => {
  it('returns the alphabetically-first path', () => {
    expect(firstNotePath([{ path: 'b.md' }, { path: 'a.md' }])).toBe('a.md');
    expect(firstNotePath([{ path: 'only.md' }])).toBe('only.md');
    expect(firstNotePath([])).toBeUndefined();
  });
});

describe('makeDebouncedSaver', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid edits into one save with the last value', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = makeDebouncedSaver(save, 600);
    saver.schedule('n.md', 'a');
    saver.schedule('n.md', 'ab');
    saver.schedule('n.md', 'abc');
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('n.md', 'abc');
  });

  it('flush() fires a pending save immediately', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const saver = makeDebouncedSaver(save, 600);
    saver.schedule('n.md', 'x');
    saver.flush();
    expect(save).toHaveBeenCalledWith('n.md', 'x');
    // no double-fire after flush
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
