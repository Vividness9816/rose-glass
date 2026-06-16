/* Editor pane — mockup chrome (breadcrumb / title / meta / backlinks) as React,
   with a live CodeMirror 6 host in place of the static body. */

import type { BacklinkDto, NoteDto } from '../ipc';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';

interface Props {
  note: NoteDto | null;
  doc: string;
  backlinks: BacklinkDto[];
  onChangeDoc: (doc: string) => void;
  onOpenPath: (path: string) => void;
  onWikiClick: (target: string) => void;
}

function relativeTime(mtimeMs: number): string {
  const days = Math.floor((Date.now() - mtimeMs) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function EditorPane({ note, doc, backlinks, onChangeDoc, onOpenPath, onWikiClick }: Props) {
  const segments = note ? note.path.split('/').slice(0, -1) : [];
  const fm = (note?.frontmatter ?? null) as Record<string, unknown> | null;
  const dateStr =
    typeof fm?.date === 'string'
      ? fm.date
      : note
        ? new Date(note.mtime).toLocaleDateString()
        : '';

  return (
    <div className="editor-pane">
      <div className="editor-header">
        <div className="breadcrumb">
          {segments.map((seg, i) => (
            <span key={i} style={{ display: 'contents' }}>
              <span className="bc-seg">{seg}</span>
              <span className="bc-sep">›</span>
            </span>
          ))}
          <span className="bc-current">{note?.title ?? 'No note open'}</span>
        </div>
        <div className="editor-actions">
          <button className="ea-btn" title="Outline" type="button">≡</button>
          <button className="ea-btn" title="Properties" type="button">◈</button>
          <button className="ea-btn" title="Share" type="button">↗</button>
        </div>
      </div>

      <div className="editor-body selectable">
        <div className="note-title">{note?.title ?? 'No note open'}</div>
        {note && (
          <div className="note-meta">
            <span>📅 {dateStr}</span>
            <span>⟳ {relativeTime(note.mtime)}</span>
            <span>◈ {note.word_count} words</span>
            <span>↙ {backlinks.length} backlinks</span>
          </div>
        )}

        <CodeMirrorHost
          className="note-body cm-host"
          doc={doc}
          notePath={note?.path ?? null}
          onChangeDoc={onChangeDoc}
          onWikiClick={onWikiClick}
        />

        {backlinks.length > 0 && (
          <div className="backlinks">
            <div className="bl-label">Backlinks · {backlinks.length}</div>
            {backlinks.map((b) => (
              <button
                key={b.src_path}
                className="bl-item"
                type="button"
                onClick={() => onOpenPath(b.src_path)}
              >
                <div className={`bl-dot${b.link_type !== 'wikilink' ? ' bl-dot-violet' : ''}`} />
                <div>
                  <div className="bl-title">{b.src_title}</div>
                  <div className="bl-excerpt">{b.src_path}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
