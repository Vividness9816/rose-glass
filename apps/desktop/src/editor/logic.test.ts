import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEol,
  detectEol,
  extractWikiTarget,
  firstNotePath,
  makeDebouncedSaver,
  shouldReloadDoc,
  toLf,
} from './logic';

describe('EOL handling', () => {
  it('detects CRLF vs LF', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
  });
  it('normalizes to LF and re-applies the original ending (identity round-trip)', () => {
    const crlf = 'x\r\ny\r\nz';
    expect(toLf(crlf)).toBe('x\ny\nz');
    expect(applyEol(toLf(crlf), detectEol(crlf))).toBe(crlf);
    const lf = 'x\ny\nz';
    expect(applyEol(toLf(lf), detectEol(lf))).toBe(lf);
  });
});

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

  it('flush() resolves only after the pending async write settles (R3)', async () => {
    let done = false;
    const saver = makeDebouncedSaver(async () => {
      await Promise.resolve();
      done = true;
    }, 600);
    saver.schedule('n.md', 'x');
    await saver.flush();
    expect(done).toBe(true);
  });
});
