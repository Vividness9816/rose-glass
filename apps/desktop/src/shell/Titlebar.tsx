/* Titlebar — draggable, traffic lights wired to the Tauri window (no-op
   outside Tauri, e.g. under plain Vite / Playwright), right action cluster. */

async function windowAction(action: 'close' | 'minimize' | 'toggleMaximize') {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    if (action === 'close') await w.close();
    else if (action === 'minimize') await w.minimize();
    else await w.toggleMaximize();
  } catch {
    /* not running under Tauri — controls are inert */
  }
}

export function Titlebar({
  vault,
  onSearch,
  onOpenFile,
  onShare,
  onNewNote,
  canOpenFile = true,
}: {
  vault: string;
  onSearch?: () => void;
  onOpenFile?: () => void;
  onShare?: () => void;
  onNewNote?: () => void;
  canOpenFile?: boolean;
}) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="traffic-lights">
        <button
          className="tl tl-close"
          type="button"
          aria-label="Close"
          title="Close"
          onClick={() => windowAction('close')}
        >
          <span className="tl-glyph" aria-hidden="true">×</span>
        </button>
        <button
          className="tl tl-min"
          type="button"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => windowAction('minimize')}
        >
          <span className="tl-glyph" aria-hidden="true">−</span>
        </button>
        <button
          className="tl tl-max"
          type="button"
          aria-label="Maximize"
          title="Maximize"
          onClick={() => windowAction('toggleMaximize')}
        >
          <span className="tl-glyph" aria-hidden="true">+</span>
        </button>
      </div>
      <div className="title-center">{vault} — Rose Glass</div>
      <div className="titlebar-right">
        <button className="tb-btn" type="button" onClick={onSearch}>⌘K Search</button>
        <button
          className="tb-btn"
          type="button"
          onClick={onOpenFile}
          disabled={!canOpenFile}
          title={canOpenFile ? 'Open a PDF / Word doc / note from the vault' : 'Open a vault first'}
        >
          ⎘ Open file
        </button>
        <button
          className="tb-btn"
          type="button"
          onClick={onShare}
          disabled={!canOpenFile}
          title={canOpenFile ? 'Reveal the vault folder in your file explorer' : 'Open a vault first'}
        >
          ↗ Share
        </button>
        <button
          className="tb-btn primary"
          type="button"
          onClick={onNewNote}
          disabled={!canOpenFile}
          title={canOpenFile ? 'Create a new note' : 'Open a vault first'}
        >
          + New note
        </button>
      </div>
    </div>
  );
}
