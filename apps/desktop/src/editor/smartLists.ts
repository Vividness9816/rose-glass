/* Smart-lists: continue/renumber a Markdown list item on Enter, exit on an empty item.
   ponytail: a pragmatic line-level heuristic, not a full Markdown list AST — handles
   `-`/`*`/`+` and `N.` with indent preservation; cross-blank renumber is best-effort. */
import { EditorSelection } from '@codemirror/state';
import { keymap } from '@codemirror/view';

const UNORDERED = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)\.\s+(.*)$/;

export function listContinuation(
  lineText: string,
): { kind: 'continue'; insert: string } | { kind: 'clear' } | null {
  const u = UNORDERED.exec(lineText);
  if (u) {
    const [, indent, bullet, body] = u;
    return body.length === 0 ? { kind: 'clear' } : { kind: 'continue', insert: `${indent}${bullet} ` };
  }
  const o = ORDERED.exec(lineText);
  if (o) {
    const [, indent, num, body] = o;
    if (body.length === 0) return { kind: 'clear' };
    return { kind: 'continue', insert: `${indent}${Number(num) + 1}. ` };
  }
  return null;
}

/** Enter handler: applies listContinuation at the cursor's line. Returns false (default
    newline) for non-list lines or a non-end-of-line cursor, so normal editing is untouched. */
export const smartListKeymap = keymap.of([
  {
    key: 'Enter',
    run: (view) => {
      const { state } = view;
      const sel = state.selection.main;
      if (!sel.empty) return false;
      const line = state.doc.lineAt(sel.head);
      if (sel.head !== line.to) return false; // only continue from end of the line
      const cont = listContinuation(line.text);
      if (!cont) return false;
      if (cont.kind === 'clear') {
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: '' },
          selection: EditorSelection.cursor(line.from),
        });
        return true;
      }
      const insert = '\n' + cont.insert;
      view.dispatch({
        changes: { from: sel.head, insert },
        selection: EditorSelection.cursor(sel.head + insert.length),
      });
      return true;
    },
  },
]);
