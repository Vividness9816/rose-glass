/* Notes pane (rail ≡) — the full note list from the index; clicking opens a note.
   Presentational; the note list comes from the live graph data in Shell. */

import { Icon } from '../icons/Icon';
import './panes.css';

interface NoteItem {
  path: string;
  title: string;
}

export function NotesPane({
  notes,
  activePath,
  onOpen,
}: {
  notes: NoteItem[];
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const sorted = [...notes].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div className="side-pane">
      <div className="sp-header">
        <span className="sp-glyph">
          <Icon name="notes" size="sm" />
        </span>
        <span className="sp-title">notes</span>
        <span className="sp-count">{notes.length}</span>
      </div>
      <div className="sp-list">
        {sorted.length === 0 ? (
          <div className="sp-empty">No notes yet. Open a vault of Markdown to populate this list.</div>
        ) : (
          sorted.map((n) => (
            <button
              key={n.path}
              type="button"
              className={`sp-row${n.path === activePath ? ' active' : ''}`}
              onClick={() => onOpen(n.path)}
            >
              <span className="sp-row-title">{n.title}</span>
              <span className="sp-row-sub">{n.path}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
