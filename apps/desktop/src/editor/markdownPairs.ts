/* Auto-pair Markdown emphasis/code delimiters. closeBrackets (CodeMirrorHost) handles
   ()[]{}""'' — `*_`~ are Markdown-specific, so pair them here via inputHandler: wrap a
   selection, or insert the pair with the cursor between on an empty selection. */
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

const PAIRS = new Set(['*', '_', '`', '~']);

export const markdownPairExtension = EditorView.inputHandler.of((view, from, to, text) => {
  if (!PAIRS.has(text)) return false;
  if (from !== to) {
    // wrap the current selection: insert the delimiter at both ends, keep it selected
    view.dispatch({
      changes: [
        { from, insert: text },
        { from: to, insert: text },
      ],
      selection: EditorSelection.range(from + 1, to + 1),
    });
    return true;
  }
  // empty selection: insert the pair and place the cursor between
  view.dispatch({
    changes: { from, insert: text + text },
    selection: EditorSelection.cursor(from + 1),
  });
  return true;
});
