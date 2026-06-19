/* Titlebar — draggable, traffic lights wired to the Tauri window (no-op
   outside Tauri, e.g. under plain Vite / Playwright), right action cluster. */

import { Icon } from '../icons/Icon';

async function windowAction(action: 'close' | 'minimize' | 'toggleMaximize' | 'toggleFullscreen') {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    if (action === 'close') await w.close();
    else if (action === 'minimize') await w.minimize();
    else if (action === 'toggleFullscreen') await w.setFullscreen(!(await w.isFullscreen()));
    else await w.toggleMaximize();
  } catch (e) {
    /* not running under Tauri (web build) — controls are inert */
    console.debug('window action unavailable:', e);
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
        <button
          className="tb-btn"
          type="button"
          onClick={() => windowAction('toggleFullscreen')}
          title="Toggle fullscreen"
          aria-label="Toggle fullscreen"
        >
          <Icon name="fullscreen" size="sm" />
        </button>
        <button className="tb-btn" type="button" onClick={onSearch}>⌘K Search</button>
        <button
          className="tb-btn"
          type="button"
          onClick={onOpenFile}
          disabled={!canOpenFile}
          title={canOpenFile ? 'Open a PDF / Word doc / note from the vault' : 'Open a vault first'}
        >
          <Icon name="file" size="sm" /> Open file
        </button>
        <button
          className="tb-btn"
          type="button"
          onClick={onShare}
          disabled={!canOpenFile}
          title={canOpenFile ? 'Reveal the vault folder in your file explorer' : 'Open a vault first'}
        >
          <Icon name="share" size="sm" /> Share
        </button>
        <button
          className="tb-btn primary"
          type="button"
          onClick={onNewNote}
          disabled={!canOpenFile}
          title={canOpenFile ? 'Create a new note' : 'Open a vault first'}
        >
          <Icon name="plus" size="sm" /> New note
        </button>
      </div>
    </div>
  );
}
