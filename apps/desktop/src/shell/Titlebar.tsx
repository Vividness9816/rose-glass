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

export function Titlebar({ vault, onSearch }: { vault: string; onSearch?: () => void }) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="traffic-lights">
        <button
          className="tl tl-close"
          type="button"
          aria-label="Close"
          onClick={() => windowAction('close')}
        />
        <button
          className="tl tl-min"
          type="button"
          aria-label="Minimize"
          onClick={() => windowAction('minimize')}
        />
        <button
          className="tl tl-max"
          type="button"
          aria-label="Maximize"
          onClick={() => windowAction('toggleMaximize')}
        />
      </div>
      <div className="title-center">{vault} — Rose Glass</div>
      <div className="titlebar-right">
        <button className="tb-btn" type="button" onClick={onSearch}>⌘K Search</button>
        <button className="tb-btn" type="button">↗ Share</button>
        <button className="tb-btn primary" type="button">+ New note</button>
      </div>
    </div>
  );
}
