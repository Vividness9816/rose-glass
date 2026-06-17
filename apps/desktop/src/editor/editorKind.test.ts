import { describe, expect, it } from 'vitest';
import { editorKind } from './editorKind';

describe('editorKind', () => {
  it('routes markdown/text to the CM6 path', () => {
    expect(editorKind('notes/a.md')).toBe('markdown');
    expect(editorKind('a.markdown')).toBe('markdown');
    expect(editorKind('a.txt')).toBe('markdown');
  });
  it('recognizes pdf/docx (case-insensitive)', () => {
    expect(editorKind('paper.PDF')).toBe('pdf');
    expect(editorKind('report.docx')).toBe('docx');
  });
  it('treats unknown/extensionless as other', () => {
    expect(editorKind('image.png')).toBe('other');
    expect(editorKind('Makefile')).toBe('other');
    expect(editorKind('a.b.pdf')).toBe('pdf'); // last segment wins
  });
});
