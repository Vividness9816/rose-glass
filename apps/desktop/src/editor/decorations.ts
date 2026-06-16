import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

export type TokenKind = 'wikilink' | 'tag' | 'inline-code';
export interface Token {
  start: number;
  len: number;
  kind: TokenKind;
}

// inline-code is tried BEFORE tag so `#x` is a code span, not a backtick-bounded
// tag (the tag boundary class would otherwise eat the opening backtick).
// Tag rule mirrors the Rust indexer's TAG (letter-first). NOTE: multi-line code
// FENCES are not masked here — a wikilink/tag inside a ``` block is still painted
// (cosmetic only; clicking resolves via the backend index, so inert links no-op).
const TOKEN_RE = /(!?\[\[[^\]\n]+?\]\])|(`[^`\n]+?`)|(?:^|[^\w&;#/])(#\p{L}[\p{L}\p{N}/_-]*)/gu;

/** Pure tokenizer over a single text slice — unit-tested in decorations.test.ts. */
export function scanTokens(text: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const token = m[1] ?? m[2] ?? m[3];
    if (!token) continue;
    const kind: TokenKind = m[1] ? 'wikilink' : m[2] ? 'inline-code' : 'tag';
    out.push({ start: m.index + m[0].indexOf(token), len: token.length, kind });
  }
  return out;
}

const MARKS: Record<TokenKind, Decoration> = {
  wikilink: Decoration.mark({ class: 'cm-wikilink' }),
  tag: Decoration.mark({ class: 'cm-tag' }),
  'inline-code': Decoration.mark({ class: 'cm-inline-code' }),
};

function buildDecorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const t of scanTokens(text)) {
      b.add(from + t.start, from + t.start + t.len, MARKS[t.kind]);
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
