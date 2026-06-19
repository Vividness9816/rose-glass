/* Settings pane (rail ⚙) — the few real knobs: theme, the open vault, a manual
   reindex (rebuild the derived index from disk), and an about line. */

import { useState } from 'react';
import { activityHookArm, activityHookDisarm, activityHookPlan, inTauri } from '../ipc';
import type { Theme } from '../appearance/theme';
import { Icon } from '../icons/Icon';
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
  const [hookMsg, setHookMsg] = useState('');
  const [hookBusy, setHookBusy] = useState(false);
  const runHook = async (action: 'plan' | 'arm' | 'disarm') => {
    if (hookBusy || !inTauri()) return;
    if (action === 'arm') {
      const ok = window.confirm(
        'Arm the Claude Code activity hook?\n\nThis edits ~/.claude/settings.json. A timestamped backup is written FIRST, and every existing hook is re-validated to survive the change. You can Disarm to revert.',
      );
      if (!ok) return;
    }
    setHookBusy(true);
    try {
      const fn =
        action === 'plan' ? activityHookPlan : action === 'arm' ? activityHookArm : activityHookDisarm;
      setHookMsg(await fn());
    } catch (e) {
      setHookMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setHookBusy(false);
    }
  };
  return (
    <div className="side-pane">
      <div className="sp-header">
        <span className="sp-glyph">
          <Icon name="settings" size="sm" />
        </span>
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
          <div className="sp-field-label">Claude Code activity hook (optional · M2 deferred)</div>
          <div className="sp-field-value">
            The activity mirror already works via the always-on transcript tail (M1). The global
            hook (M2) is a safe, reversible <em>no-op placeholder</em> — its event forwarding is
            deferred, so arming it has no runtime effect today; it only exercises the proven install
            path. It edits <code>~/.claude/settings.json</code> behind a timestamped backup + a
            re-validation that every existing hook survives. Disarm reverts.
          </div>
          <div className="sp-hook-actions">
            <button type="button" className="sp-btn" onClick={() => void runHook('plan')} disabled={hookBusy}>
              Dry-run
            </button>
            <button type="button" className="sp-btn" onClick={() => void runHook('arm')} disabled={hookBusy}>
              Arm
            </button>
            <button type="button" className="sp-btn" onClick={() => void runHook('disarm')} disabled={hookBusy}>
              Disarm
            </button>
          </div>
          {hookMsg && <div className="sp-field-value sp-hook-msg">{hookMsg}</div>}
        </div>
        <div className="sp-field">
          <div className="sp-field-label">About</div>
          <div className="sp-field-value">Rose Glass — local-first PKM + live Claude Code mirror.</div>
        </div>
      </div>
    </div>
  );
}
