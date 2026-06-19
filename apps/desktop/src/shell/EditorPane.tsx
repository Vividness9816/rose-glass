/* Editor pane — mockup chrome (breadcrumb / title / meta / backlinks) as React.
   Markdown notes get a live CodeMirror 6 host. Non-markdown binaries (PDF/docx) are
   not indexed notes — they arrive via `binaryPath` and render their view engine
   (PdfView / DocxView). The .docx "Edit as Markdown" action surfaces through
   onEditAsMarkdown (Phase 9 / ADR-20260617). */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import {
  fileSize,
  inTauri,
  onIndexRebuilt,
  relatedNotes,
  type BacklinkDto,
  type NoteDto,
  type SemanticResult,
} from '../ipc';
import { CodeMirrorHost } from '../editor/CodeMirrorHost';
import { Icon } from '../icons/Icon';
import { editorKind } from '../editor/editorKind';
import { parseOutline } from '../editor/outline';
import { useSettings } from '../settings/SettingsContext';

// Lazy-split the viewers so pdfjs/mammoth/dompurify stay OFF the critical path (the
// project's three.js/ShaderBackdrop pattern) — loaded only when a binary is opened.
const PdfView = lazy(() => import('../editor/PdfView').then((m) => ({ default: m.PdfView })));
const DocxView = lazy(() => import('../editor/DocxView').then((m) => ({ default: m.DocxView })));
// markdown-it (+ DOMPurify) ride the reading view — lazy so they stay off the boot chunk.
const ReadingView = lazy(() => import('../editor/ReadingView').then((m) => ({ default: m.ReadingView })));

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Breadcrumb({ path, current }: { path: string[]; current: string }) {
  return (
    <div className="breadcrumb">
      {path.map((seg, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <span className="bc-seg">{seg}</span>
          <span className="bc-sep">
            <Icon name="chevronRight" size={12} />
          </span>
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
  // Editor-header tools (Outline / Properties / Share). Hooks run unconditionally,
  // before the binary early-return below.
  const editorViewRef = useRef<EditorView | null>(null);
  const [panel, setPanel] = useState<'none' | 'outline' | 'properties'>('none');
  const [copied, setCopied] = useState(false);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [related, setRelated] = useState<SemanticResult | null>(null);
  const [rebuiltNonce, setRebuiltNonce] = useState(0);
  // v2.3 reading mode: per-note edit/read, seeded from the Default-view setting (leg 4 lifts
  // this to per-tab). Resets to the default whenever the open note changes.
  const settings = useSettings();
  const [mode, setMode] = useState<'edit' | 'read'>(settings.defaultView);
  useEffect(() => {
    setMode(settings.defaultView);
  }, [note?.path, settings.defaultView]);

  // Refetch related notes after a full reindex / cluster recompute (index:rebuilt) so the
  // panel self-heals from "recompute to enable" → populated without a note switch.
  useEffect(() => {
    if (!inTauri()) return;
    let active = true;
    let un: (() => void) | undefined;
    onIndexRebuilt(() => setRebuiltNonce((n) => n + 1)).then((u) => {
      if (active) un = u;
      else u();
    });
    return () => {
      active = false;
      un?.();
    };
  }, []);

  // Phase 13: fetch semantically-related notes when the open note changes (model-free —
  // the note's vector is already stored, so this is a cheap DB scan). Keyed on the path so
  // a same-note refetch (autosave → getNote) doesn't re-run; also on rebuiltNonce so a
  // recompute repopulates it. Silent on the web build.
  useEffect(() => {
    setRelated(null);
    if (!note || !inTauri()) return;
    let cancelled = false;
    relatedNotes(note.path, 6)
      .then((r) => {
        if (!cancelled) setRelated(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key on the path + rebuild nonce, not the object identity
  }, [note?.path, rebuiltNonce]);

  // Fetch the note's on-disk byte size when the Properties popover opens (cheap stat IPC).
  useEffect(() => {
    setSizeBytes(null);
    if (panel !== 'properties' || !note || !inTauri()) return;
    let cancelled = false;
    fileSize(note.path)
      .then((n) => {
        if (!cancelled) setSizeBytes(n);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [panel, note]);

  const scrollToLine = (line: number) => {
    const view = editorViewRef.current;
    if (!view) return;
    const ln = Math.min(Math.max(1, line), view.state.doc.lines);
    const pos = view.state.doc.line(ln).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    view.focus();
    setPanel('none');
  };
  const onShare = async () => {
    try {
      // navigator.clipboard is blocked in the Tauri webview → use the clipboard plugin
      // there; fall back to the Web API for the plain browser build.
      if (inTauri()) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(doc);
      } else {
        await navigator.clipboard.writeText(doc);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      // expected on the web build (navigator.clipboard denied in a non-secure context)
      console.debug('copy as markdown failed:', e);
    }
  };

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
                <div className="fp-icon">
                  <Icon name="file" size={36} />
                </div>
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
          <button
            className={`ea-btn${mode === 'read' ? ' active' : ''}`}
            title={mode === 'read' ? 'Switch to editing' : 'Switch to reading'}
            type="button"
            disabled={!note}
            onClick={() => setMode((m) => (m === 'read' ? 'edit' : 'read'))}
          >
            <Icon name={mode === 'read' ? 'edit' : 'book'} size="sm" />
          </button>
          <button
            className={`ea-btn${panel === 'outline' ? ' active' : ''}`}
            title="Outline"
            type="button"
            disabled={!note}
            onClick={() => setPanel((p) => (p === 'outline' ? 'none' : 'outline'))}
          >
            <Icon name="outline" size="sm" />
          </button>
          <button
            className={`ea-btn${panel === 'properties' ? ' active' : ''}`}
            title="Properties"
            type="button"
            disabled={!note}
            onClick={() => setPanel((p) => (p === 'properties' ? 'none' : 'properties'))}
          >
            <Icon name="properties" size="sm" />
          </button>
          <button
            className={`ea-btn${copied ? ' active' : ''}`}
            title={copied ? 'Copied!' : 'Copy as Markdown'}
            type="button"
            disabled={!note}
            onClick={() => void onShare()}
          >
            <Icon name="share" size="sm" />
          </button>
        </div>
        {panel === 'outline' && (
          <div className="editor-popover" role="menu">
            {parseOutline(doc).length === 0 ? (
              <div className="ep-empty">No headings in this note.</div>
            ) : (
              parseOutline(doc).map((h) => (
                <button
                  key={`${h.line}-${h.text}`}
                  type="button"
                  className="ep-outline-row"
                  style={{ paddingLeft: 12 + (h.level - 1) * 12 }}
                  onClick={() => scrollToLine(h.line)}
                >
                  {h.text}
                </button>
              ))
            )}
          </div>
        )}
        {panel === 'properties' && (
          <div className="editor-popover">
            <div className="ep-row">
              <span className="ep-key">size</span>
              <span className="ep-val">{sizeBytes != null ? formatBytes(sizeBytes) : '…'}</span>
            </div>
            {fm &&
              Object.entries(fm).map(([k, v]) => (
                <div key={k} className="ep-row">
                  <span className="ep-key">{k}</span>
                  <span className="ep-val">{String(v)}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="editor-body selectable">
        <div className="note-title">{note?.title ?? 'No note open'}</div>
        {note && (
          <div className="note-meta">
            <span><Icon name="calendar" size={12} /> {dateStr}</span>
            <span><Icon name="clock" size={12} /> {relativeTime(note.mtime)}</span>
            <span><Icon name="words" size={12} /> {note.word_count} words</span>
            <span><Icon name="backlink" size={12} /> {backlinks.length} backlinks</span>
          </div>
        )}

        {mode === 'read' ? (
          <Suspense fallback={<div className="bv-status">Rendering…</div>}>
            <ReadingView className="note-body" doc={doc} onWikiClick={onWikiClick} />
          </Suspense>
        ) : (
          <CodeMirrorHost
            className="note-body cm-host"
            doc={doc}
            notePath={note?.path ?? null}
            onChangeDoc={onChangeDoc}
            onWikiClick={onWikiClick}
            editorViewRef={editorViewRef}
          />
        )}

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

        {related && related.hits.length > 0 && (
          <div className="backlinks">
            <div className="bl-label">
              Related · {related.hits.length}
              {related.stale ? ' · may be out of date' : ''}
              {related.corpus_size > 0 ? ` · ${related.corpus_size} notes in ${related.elapsed_ms}ms` : ''}
            </div>
            {related.hits.map((h) => (
              <button key={h.path} className="bl-item" type="button" onClick={() => onOpenPath(h.path)}>
                <div className="bl-dot bl-dot-violet" />
                <div>
                  <div className="bl-title">{h.title}</div>
                  <div className="bl-excerpt">
                    {h.path} · {Math.round(h.score * 100)}% similar
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Freshness contract (ADR-20260618): when there are no hits because embeddings
            aren't computed (or this note isn't embedded yet), say so + how to fix — don't
            stay silent. A genuinely-unrelated note (ready, fresh, 0 hits) shows nothing. */}
        {note && related && related.hits.length === 0 && (!related.ready || related.stale) && (
          <div className="backlinks">
            <div className="bl-label">Related</div>
            <div className="bl-excerpt" style={{ padding: '2px 2px 0' }}>
              {related.ready
                ? 'This note has no embedding yet. Click “Clusters” in the graph header to refresh semantic search.'
                : 'Click “Clusters” in the graph header to enable semantic search.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
