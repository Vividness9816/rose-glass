/* Editor pane — mockup chrome (breadcrumb / title / meta / backlinks) as React.
   Markdown notes get a live CodeMirror 6 host. Non-markdown binaries (PDF/docx) are
   not indexed notes — they arrive via `binaryPath` and render their view engine
   (PdfView / DocxView). The .docx "Edit as Markdown" action surfaces through
   onEditAsMarkdown (Phase 9 / ADR-20260617). */

import { lazy, Suspense } from 'react';
import type { BacklinkDto, NoteDto } from '../ipc';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';
import { editorKind } from '../editor/editorKind';

// Lazy-split the viewers so pdfjs/mammoth/dompurify stay OFF the critical path (the
// project's three.js/ShaderBackdrop pattern) — loaded only when a binary is opened.
const PdfView = lazy(() => import('../editor/PdfView').then((m) => ({ default: m.PdfView })));
const DocxView = lazy(() => import('../editor/DocxView').then((m) => ({ default: m.DocxView })));

interface Props {
  note: NoteDto | null;
  doc: string;
  backlinks: BacklinkDto[];
  /** When set, a non-markdown binary (pdf/docx) is open instead of a note. */
  binaryPath: string | null;
  onChangeDoc: (doc: string) => void;
  onOpenPath: (path: string) => void;
  onWikiClick: (target: string) => void;
  onEditAsMarkdown: (docxPath: string, markdown: string) => void;
}

function relativeTime(mtimeMs: number): string {
  const days = Math.floor((Date.now() - mtimeMs) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function Breadcrumb({ path, current }: { path: string[]; current: string }) {
  return (
    <div className="breadcrumb">
      {path.map((seg, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="bc-seg">{seg}</span>
          <span className="bc-sep">›</span>
        </span>
      ))}
      <span className="bc-current">{current}</span>
    </div>
  );
}

export function EditorPane({
  note,
  doc,
  backlinks,
  binaryPath,
  onChangeDoc,
  onOpenPath,
  onWikiClick,
  onEditAsMarkdown,
}: Props) {
  // ── Binary (PDF/docx) view — not an indexed note ──
  if (binaryPath) {
    const kind = editorKind(binaryPath);
    return (
      <div className="editor-pane">
        <div className="editor-header">
          <Breadcrumb
            path={binaryPath.split('/').slice(0, -1)}
            current={binaryPath.split('/').pop() ?? binaryPath}
          />
        </div>
        <div className="editor-body">
          {/* key={binaryPath}: remount on a path switch so a viewer's async load/teardown
              never races against a stale prior instance (fresh refs + lifecycle per file). */}
          <Suspense fallback={<div className="bv-status">Loading viewer…</div>}>
            {kind === 'pdf' ? (
              <PdfView key={binaryPath} path={binaryPath} />
            ) : kind === 'docx' ? (
              <DocxView key={binaryPath} path={binaryPath} onEditAsMarkdown={onEditAsMarkdown} />
            ) : (
              <div className="format-placeholder">
                <div className="fp-icon">◫</div>
                <div className="fp-title">Unsupported file</div>
                <div className="fp-note">{binaryPath.split('/').pop()} can&apos;t be opened in-app.</div>
              </div>
            )}
          </Suspense>
        </div>
      </div>
    );
  }

  // ── Markdown note view ──
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
        <Breadcrumb path={segments} current={note?.title ?? 'No note open'} />
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
