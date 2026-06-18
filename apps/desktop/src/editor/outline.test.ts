import { describe, expect, it } from 'vitest';
import { parseOutline } from './outline';

describe('parseOutline', () => {
  it('extracts ATX headings with level + 1-based line', () => {
    const doc = '# Title\n\nbody\n\n## Section\ntext\n### Sub';
    expect(parseOutline(doc)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Section', line: 5 },
      { level: 3, text: 'Sub', line: 7 },
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const doc = '# Real\n```\n# not a heading\n```\n## Also real';
    expect(parseOutline(doc).map((h) => h.text)).toEqual(['Real', 'Also real']);
  });

  it('strips trailing hashes and is empty for no headings', () => {
    expect(parseOutline('## Closed ##')).toEqual([{ level: 2, text: 'Closed', line: 1 }]);
    expect(parseOutline('just text\nno headings')).toEqual([]);
  });
});
