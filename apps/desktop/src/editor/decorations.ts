import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

// Wikilink/embed: ![[...]] | [[...]]  (alias/# kept inside, painted whole).
// Tag: mirrors the Rust parser's TAG — boundary, FIRST char a letter, then
//      letters/digits/_/-//, so highlighting == indexing (no leading digit, no ##).
// Inline code: `code` (single backtick, no embedded backtick/newline).
const TOKEN_RE = /(!?\[\[[^\]\n]+?\]\])|(?:^|[^\w&;#/])(#\p{L}[\p{L}\p{N}/_-]*)|(`[^`\n]+?`)/gu;

const wikilinkMark = Decoration.mark({ class: 'cm-wikilink' });
const tagMark = Decoration.mark({ class: 'cm-tag' });
const inlineCodeMark = Decoration.mark({ class: 'cm-inline-code' });

function buildDecorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text))) {
      const token = m[1] ?? m[2] ?? m[3];
      if (!token) continue;
      const start = from + m.index + m[0].indexOf(token); // skip the boundary char
      const mark = m[1] ? wikilinkMark : m[2] ? tagMark : inlineCodeMark;
      b.add(start, start + token.length, mark);
    }
  }
  return b.finish();
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
