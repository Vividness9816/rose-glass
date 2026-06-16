import { EditorView } from '@codemirror/view';

const WIKILINK_AT = /!?\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;

/** Plain left-click on a [[wikilink]] → onWiki(target). Ignores modified clicks. */
export function wikilinkClickHandler(onWiki: (target: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      WIKILINK_AT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK_AT.exec(line.text))) {
        const start = line.from + m.index;
        const end = start + m[0].length;
        if (pos >= start && pos <= end) {
          onWiki(m[1].trim());
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
  });
}
