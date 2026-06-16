import { EditorView } from '@codemirror/view';
import { extractWikiTarget } from './logic';

const WIKILINK_AT = /!?\[\[([^\]\n]+?)\]\]/g;

/** Mod/Ctrl-click on a [[wikilink]] → onWiki(target). Plain click places the caret
 *  (so the link text stays editable). */
export function wikilinkClickHandler(onWiki: (target: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      WIKILINK_AT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK_AT.exec(line.text))) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (pos >= start && pos < end) {
          onWiki(extractWikiTarget(m[1]));
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
  });
}
