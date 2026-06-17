/* Phase 9 — route a file to its editor engine by extension. Pure. markdown (+txt) edits
   via CodeMirror 6; pdf renders read-only via PDF.js; docx renders read-only via mammoth
   and edits as a sibling .md (ADR-20260617 — no MuPDF, no TipTap, no in-place binary write).
   Pure → the routing is testable and the engines drop in behind it without touching it. */

export type EditorKind = 'markdown' | 'pdf' | 'docx' | 'other';

export function editorKind(path: string): EditorKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  return 'other';
}
