/* Settings pane (rail ⚙) — the few real knobs: theme, the open vault, a manual
   reindex (rebuild the derived index from disk), and an about line. */

import type { Theme } from '../appearance/theme';
import './panes.css';

export function SettingsPane({
  theme,
  onToggleTheme,
  vault,
  onReindex,
  reindexing,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  vault: string;
  onReindex: () => void;
  reindexing: boolean;
}) {
  return (
    <div className="side-pane">
      <div className="sp-header">
        <span className="sp-glyph">⚙</span>
        <span className="sp-title">settings</span>
      </div>
      <div className="sp-body">
        <div className="sp-field">
          <div className="sp-field-label">Theme</div>
          <button type="button" className="sp-btn" onClick={onToggleTheme}>
            {theme === 'dark' ? 'Dark' : 'Light'} — switch
          </button>
        </div>
        <div className="sp-field">
          <div className="sp-field-label">Vault</div>
          <div className="sp-field-value">{vault}</div>
        </div>
        <div className="sp-field">
          <div className="sp-field-label">Index</div>
          <button type="button" className="sp-btn" onClick={onReindex} disabled={reindexing}>
            {reindexing ? 'Reindexing…' : 'Rebuild index from disk'}
          </button>
          <div className="sp-field-value">
            SQLite is a derived cache — rebuilding re-reads the vault; your Markdown is untouched.
          </div>
        </div>
        <div className="sp-field">
          <div className="sp-field-label">About</div>
          <div className="sp-field-value">Rose Glass — local-first PKM + live Claude Code mirror.</div>
        </div>
      </div>
    </div>
  );
}
