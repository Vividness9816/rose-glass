/* Phase 9 — read-only PDF viewer (PDF.js / pdfjs-dist v6). View-only by ADR-20260617:
   Rose Glass never writes a PDF (pdf-lib re-serialize is the same silent-corruption
   class the council rejected for docx). Bytes come from the vault via the size-capped
   `read_file_bytes` IPC (behind `safe_join`).

   Hardening (ADR): the worker is bundled LOCALLY via Vite's `?url` (never a CDN — §2.1
   local-first); pdfjs v6 removed the old `isEvalSupported` eval fast-path entirely, so
   that attack surface no longer exists; `enableXfa:false` keeps the scriptable-form
   surface off; `useWasm:false` uses the pure-JS image decoder so there is no wasm asset
   to fetch/bundle. ponytail: CMap/standard-font URLs are unset — Latin PDFs render fully;
   exotic CJK/non-embedded fonts degrade gracefully. Bundle the cmaps + wasm if that bites. */

import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readFileBytes } from '../ipc';
import { Icon } from '../icons/Icon';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Status = 'loading' | 'ready' | 'error';

export function PdfView({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    setStatus('loading');
    setError('');
    hostRef.current?.replaceChildren();

    (async () => {
      try {
        const bytes = await readFileBytes(path);
        if (cancelled) return;
        task = pdfjs.getDocument({ data: bytes, enableXfa: false, useWasm: false });
        const doc = await task.promise;
        if (cancelled) return;
        // Bake dpr into the render scale: hi-dpi backing store, logical CSS size → crisp on
        // 4K. dpr capped at 2 so a huge display can't blow up canvas memory.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scale = 1.4 * dpr;
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) break;
          const page = await doc.getPage(i);
          if (cancelled) break;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          if (cancelled) break;
          hostRef.current?.appendChild(canvas);
          await page.render({ canvas, viewport }).promise; // v6: pass the canvas; pdfjs owns the 2D ctx
        }
        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy(); // destroys the worker transport; an in-flight render is dropped by the flag
    };
  }, [path]);

  const name = path.split('/').pop();
  return (
    <div className="binary-view pdf-view">
      <div className="bv-bar">
        <span className="bv-icon">
          <Icon name="file" size="md" />
        </span>
        <span className="bv-name">{name}</span>
        <span className="bv-tag">PDF · view-only</span>
      </div>
      {status === 'loading' && <div className="bv-status">Rendering PDF…</div>}
      {status === 'error' && <div className="bv-status bv-error">Could not open PDF — {error}</div>}
      <div ref={hostRef} className="pdf-pages" aria-label={`PDF: ${name}`} />
    </div>
  );
}
