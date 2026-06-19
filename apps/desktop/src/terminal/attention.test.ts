import { describe, it, expect } from 'vitest';
import { isUnattended } from './attention';

const attended = { isActiveTab: true, isDrawerVisible: true, isWindowFocused: true };

describe('isUnattended', () => {
  it('attended only when active tab + drawer visible + window focused', () => {
    expect(isUnattended(attended)).toBe(false);
  });
  it('flags when the window is blurred (you alt-tabbed away)', () => {
    expect(isUnattended({ ...attended, isWindowFocused: false })).toBe(true);
  });
  it('flags when the drawer is hidden (Ctrl+`)', () => {
    expect(isUnattended({ ...attended, isDrawerVisible: false })).toBe(true);
  });
  it('flags a background tab even if drawer visible + window focused', () => {
    expect(isUnattended({ ...attended, isActiveTab: false })).toBe(true);
  });
});
