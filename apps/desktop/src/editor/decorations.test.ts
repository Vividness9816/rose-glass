import { describe, expect, it } from 'vitest';
import { scanTokens } from './decorations';

const kinds = (s: string) => scanTokens(s).map((t) => t.kind);

describe('scanTokens', () => {
  it('classifies wikilink, tag, and inline-code in order', () => {
    expect(kinds('see [[a]] and #tag and `code`')).toEqual(['wikilink', 'tag', 'inline-code']);
  });

  it('treats `#x` as inline-code, not a backtick-bounded tag (review fix)', () => {
    const toks = scanTokens('here `#x` ok');
    expect(toks).toHaveLength(1);
    expect(toks[0].kind).toBe('inline-code');
  });

  it('extracts the exact tag span (no leading boundary char)', () => {
    const s = 'a #neuro b';
    const [t] = scanTokens(s);
    expect(s.slice(t.start, t.start + t.len)).toBe('#neuro');
  });

  it('treats ![[embed]] as a wikilink token', () => {
    expect(scanTokens('![[img]]')[0].kind).toBe('wikilink');
  });

  it('rejects non-tags exactly like the indexer (leading digit, ##, word#)', () => {
    expect(kinds('#123 ##h a#b')).toEqual([]);
  });
});
