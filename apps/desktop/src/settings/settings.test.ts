import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';

describe('mergeSettings', () => {
  it('returns defaults for null / non-object', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a partial over defaults (forward-compatible)', () => {
    const s = mergeSettings({ vimMode: true, spellcheck: false });
    expect(s.vimMode).toBe(true);
    expect(s.spellcheck).toBe(false);
    // an untouched key keeps its default
    expect(s.autoPairBrackets).toBe(DEFAULT_SETTINGS.autoPairBrackets);
  });

  it('coerces an invalid defaultView enum back to the default', () => {
    expect(mergeSettings({ defaultView: 'banana' }).defaultView).toBe(DEFAULT_SETTINGS.defaultView);
  });

  it('keeps a valid defaultView', () => {
    expect(mergeSettings({ defaultView: 'read' }).defaultView).toBe('read');
  });
});
