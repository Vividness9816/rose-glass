/* Phase 9 — route a file to its editor engine by extension. Pure. Today markdown
   (+txt) edits live via CodeMirror 6; pdf/docx are recognized + routed to a typed
   placeholder until the format-engine increment wires PDF.js/MuPDF + TipTap/docx
   (spec §15 Phase 9). Keeping this a pure function means the routing is testable and
   the engines drop in behind it without touching the router. */

export type EditorKind = 'markdown' | 'pdf' | 'docx' | 'other';

export function editorKind(path: string): EditorKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  return 'other';
}

/** Human label for the non-markdown placeholder. */
export function formatLabel(kind: EditorKind): string {
  switch (kind) {
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'Word document';
    case 'other':
      return 'file';
    case 'markdown':
      return 'Markdown';
  }
}
