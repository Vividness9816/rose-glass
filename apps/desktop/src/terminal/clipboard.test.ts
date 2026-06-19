import { describe, it, expect } from 'vitest';
import { decideContextMenu, decideKey, stripTrailingNewline } from './clipboard';

const key = (over: Partial<Parameters<typeof decideKey>[0]> = {}) => ({
  key: 'c',
  ctrlKey: true,
  shiftKey: false,
  type: 'keydown',
  ...over,
});

describe('decideContextMenu', () => {
  it('copies with a selection, pastes without', () => {
    expect(decideContextMenu(true)).toBe('copy');
    expect(decideContextMenu(false)).toBe('paste');
  });
});

describe('decideKey — Ctrl+C must stay SIGINT unless a selection is live', () => {
  it('Ctrl+C with NO selection passes through (interrupt reaches the PTY)', () => {
    expect(decideKey(key({ key: 'c' }), false)).toBe('passthrough');
  });
  it('Ctrl+C WITH a selection copies', () => {
    expect(decideKey(key({ key: 'c' }), true)).toBe('copy');
  });
  it('Ctrl+Shift+C always copies (even with no selection)', () => {
    expect(decideKey(key({ key: 'c', shiftKey: true }), false)).toBe('copy');
  });
  it('Ctrl+V pastes', () => {
    expect(decideKey(key({ key: 'v' }), false)).toBe('paste');
    expect(decideKey(key({ key: 'v', shiftKey: true }), false)).toBe('paste');
  });
  it('non-Ctrl / keyup / other keys pass through', () => {
    expect(decideKey(key({ ctrlKey: false }), true)).toBe('passthrough');
    expect(decideKey(key({ type: 'keyup' }), true)).toBe('passthrough');
    expect(decideKey(key({ key: 'a' }), true)).toBe('passthrough');
    expect(decideKey(key({ key: 'x', shiftKey: true }), true)).toBe('passthrough');
  });
});

describe('stripTrailingNewline', () => {
  it('removes exactly one trailing LF or CRLF', () => {
    expect(stripTrailingNewline('ls\n')).toBe('ls');
    expect(stripTrailingNewline('ls\r\n')).toBe('ls');
    expect(stripTrailingNewline('a\nb\nc\n')).toBe('a\nb\nc');
  });
  it('leaves text without a trailing newline untouched', () => {
    expect(stripTrailingNewline('ls')).toBe('ls');
    expect(stripTrailingNewline('a\nb')).toBe('a\nb');
  });
});
