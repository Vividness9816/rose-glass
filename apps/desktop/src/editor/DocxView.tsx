/* Phase 9 — read-only .docx view + "Edit as Markdown" (ADR-20260617 / B1). The .docx is
   NEVER mutated: mammoth (read-only) renders it for display; "Edit as Markdown" extracts
   a sibling `.md` (mammoth→markdown) that flows through the normal CodeMirror/save path.
   No docx writer, no TipTap.

   Security: a .docx is untrusted binary and mammoth preserves hyperlink hrefs (a docx can
   carry a `javascript:` link), so the generated HTML is sanitized with DOMPurify before it
   ever reaches innerHTML — defense-in-depth on top of mammoth's already-constrained output. */

import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import mammoth from 'mammoth';
import DOMPurify from 'dompurify';
import { readFileBytes } from '../ipc';

// mammoth's bundled .d.ts omits convertToMarkdown (it exists at runtime in lib/index.js —
// spike-proven). Type just the call we use rather than widening to `any`.
type ToMarkdown = (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
const convertToMarkdown = (mammoth as unknown as { convertToMarkdown: ToMarkdown }).convertToMarkdown;

// Untrusted-docx hardening (defense-in-depth alongside the v2.0 CSP in tauri.conf). DOMPurify
// already strips script/javascript:/event-handlers; this also kills the offline-first leaks:
// a remote <img src> auto-fetches on render (a tracking beacon), and we neutralize anchors.
// Module-level (DocxView is the only DOMPurify caller); anchor *navigation* is handled by the
// click interceptor below (links open in the OS browser, never replace the app frame).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG' && !(node.getAttribute('src') ?? '').startsWith('data:')) {
    node.removeAttribute('src'); // only embedded (data:) images render — no remote beacon
  }
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
    node.removeAttribute('target');
  }
});

// ponytail: a real Word doc is rarely this big. A crafted zip-bomb UNDER this cap can still
// inflate to many GB and OOM the renderer (recoverable by restart) — the full per-entry
// decompression-ratio guard is the deferred indexing-module work (ADR-20260617).
const MAX_DOCX_BYTES = 25 * 1024 * 1024;

type Status = 'loading' | 'ready' | 'error';

interface Props {
  path: string;
  /** Called with the source .docx path + the extracted markdown; the Shell derives the
   *  sibling .md path (via siblingMdPath) and writes it. The .docx is never touched. */
  onEditAsMarkdown: (docxPath: string, markdown: string) => void;
}

export function DocxView({ path, onEditAsMarkdown }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [extracting, setExtracting] = useState(false);
  const bytesRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError('');
    setHtml('');
    bytesRef.current = null;
    (async () => {
      try {
        const bytes = await readFileBytes(path);
        if (cancelled) return;
        if (bytes.length > MAX_DOCX_BYTES) {
          throw new Error(
            `document too large to render (${Math.round(bytes.length / 1048576)} MB; cap ${MAX_DOCX_BYTES / 1048576} MB)`,
          );
        }
        bytesRef.current = bytes;
        const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
        if (cancelled) return;
        setHtml(DOMPurify.sanitize(value));
        setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  const onEdit = async () => {
    if (extracting) return;
    setExtracting(true);
    try {
      const bytes = bytesRef.current ?? (await readFileBytes(path));
      const { value } = await convertToMarkdown({ arrayBuffer: bytes.buffer as ArrayBuffer });
      onEditAsMarkdown(path, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    } finally {
      setExtracting(false);
    }
  };

  // A link inside a rendered docx must NOT navigate the whole WebView2 frame away (there's
  // no in-app back, csp:null). Intercept clicks: open http(s) links in the OS browser.
  const onBodyClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest?.('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) {
      void import('@tauri-apps/plugin-opener')
        .then((m) => m.openUrl(href))
        .catch(() => {});
    }
  };

  const name = path.split('/').pop();
  return (
    <div className="binary-view docx-view">
      <div className="bv-bar">
        <span className="bv-icon">
          <Icon name="file" size="md" />
        </span>
        <span className="bv-name">{name}</span>
        <span className="bv-tag">Word · read-only</span>
        <button
          className="bv-action"
          type="button"
          onClick={() => void onEdit()}
          disabled={status !== 'ready' || extracting}
          title="Extract a Markdown sibling you can edit (the .docx is never modified)"
        >
          {extracting ? 'Extracting…' : 'Edit as Markdown'}
        </button>
      </div>
      {status === 'loading' && <div className="bv-status">Reading document…</div>}
      {status === 'error' && <div className="bv-status bv-error">Could not open document — {error}</div>}
      {status === 'ready' && (
        // eslint-disable-next-line react/no-danger -- sanitized above with DOMPurify
        <div
          className="docx-body selectable"
          onClickCapture={onBodyClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
