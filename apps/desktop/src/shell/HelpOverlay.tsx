/* v2.3 — Help overlay. Renders an in-app "What is Rose Glass?" guide through the leg-3
   ReadingView (rendered Markdown), so there's no bundled PDF / resource-read IPC to maintain
   (RG's PdfView is vault-relative only). Lazy-loaded from Shell so markdown-it stays off boot. */
import { ReadingView } from '../editor/ReadingView';
import { Icon } from '../icons/Icon';

const HELP_MD = `# Rose Glass

Rose Glass is a **local-first knowledge base** that doubles as a live mirror of your Claude Code activity. Your notes are plain Markdown files on disk — Rose Glass never locks them in.

## What it is
- A Markdown editor plus a living **knowledge graph** of your notes and the links between them.
- A **semantic** layer: local AI embeddings cluster related notes and power "Related" + search.
- A **Claude Code activity mirror**: as a CC session reads or edits a note, its graph node lights up.

## How to use it
- **Open a vault** — point Rose Glass at any folder of Markdown files (graph header → *Open vault…*).
- **Edit** notes in the editor; changes autosave to disk. Toggle **Read** (the book icon) for a rendered view.
- **Tabs** — open several notes at once. *Always focus new tabs* and the default view live in Settings → Editor.
- **Link** notes with \`[[wikilinks]]\`; backlinks and the graph update automatically.
- **Graph** — hover a node to highlight its neighbours; click to open. Drag to pan, scroll to zoom.
- **Search** with ⌘K / Ctrl+K. **Clusters** (graph header) runs local embeddings to group notes.
- **Terminal** — Ctrl+\` opens a shell at your vault, ready to run Claude Code.

## How it works
- The Rust core indexes your vault into a local SQLite cache (\`.rose-glass/index.db\`) — a *derived* cache; your Markdown is the source of truth. Rebuild it any time from Settings → Advanced.
- The graph renders on a Canvas-2D (or WebGPU) engine from that index.
- Embeddings run **locally** — no data leaves your machine; semantic search is a cosine scan over them.
- The activity mirror tails Claude Code's local session transcripts read-only — nothing is sent anywhere.

Rose Glass is yours and offline-first. Close it and your notes are exactly the Markdown files you started with.
`;

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="Help" onClick={onClose}>
      <div className="help-panel" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="help-title">Help</span>
          <button className="help-close" type="button" onClick={onClose} aria-label="Close help">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="help-body">
          <ReadingView doc={HELP_MD} onWikiClick={() => {}} />
        </div>
      </div>
    </div>
  );
}
