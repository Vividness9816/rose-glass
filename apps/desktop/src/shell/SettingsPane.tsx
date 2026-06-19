/* Settings pane (rail ⚙) — categorized: General / Editor / Behavior / Advanced. Editor
   toggles read/write the SettingsContext (CodeMirrorHost applies them live via
   compartments). The two tab-dependent Editor settings render disabled until tabs (leg 4)
   + reading mode (leg 3) land. General version/Help arrive in leg 5. */

import { useState, type ReactNode } from 'react';
import { activityHookArm, activityHookDisarm, activityHookPlan, inTauri } from '../ipc';
import type { Theme } from '../appearance/theme';
import { Icon } from '../icons/Icon';
import { useSettings, useSetSettings } from '../settings/SettingsContext';
import { Toggle, Select } from './Toggle';
import './panes.css';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sp-section">
      <div className="sp-section-title">{title}</div>
      {children}
    </div>
  );
}

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
  const s = useSettings();
  const set = useSetSettings();
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
        <Section title="General">
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
        </Section>

        <Section title="Editor">
          <Toggle
            label="Always focus new tabs"
            hint="Switch to a link opened in a new tab immediately (tabs land later in v2.3 — disabled for now)"
            checked={s.alwaysFocusNewTabs}
            disabled
            onChange={(v) => set({ alwaysFocusNewTabs: v })}
          />
          <Select
            label="Default view for new tabs"
            hint="The view a new Markdown tab opens in (reading mode lands later in v2.3 — disabled for now)"
            value={s.defaultView}
            disabled
            options={[
              { value: 'edit', label: 'Editing' },
              { value: 'read', label: 'Reading' },
            ]}
            onChange={(v) => set({ defaultView: v })}
          />
        </Section>

        <Section title="Behavior">
          <Toggle label="Spellcheck" checked={s.spellcheck} onChange={(v) => set({ spellcheck: v })} />
          <Toggle
            label="Auto-pair brackets"
            checked={s.autoPairBrackets}
            onChange={(v) => set({ autoPairBrackets: v })}
          />
          <Toggle
            label="Auto-pair Markdown syntax"
            checked={s.autoPairMarkdown}
            onChange={(v) => set({ autoPairMarkdown: v })}
          />
          <Toggle
            label="Smart lists"
            hint="Continue and renumber list items automatically"
            checked={s.smartLists}
            onChange={(v) => set({ smartLists: v })}
          />
          <Toggle
            label="Indent using tabs"
            hint="Off = indent with 4 spaces"
            checked={s.indentWithTabs}
            onChange={(v) => set({ indentWithTabs: v })}
          />
        </Section>

        <Section title="Advanced">
          <Toggle
            label="Convert pasted HTML to Markdown"
            hint="Convert HTML to Markdown on paste / drag-drop from web pages. Ctrl/Cmd+Shift+V pastes raw"
            checked={s.convertHtmlPaste}
            onChange={(v) => set({ convertHtmlPaste: v })}
          />
          <Toggle
            label="Vim key bindings"
            hint="Use Vim key bindings when editing"
            checked={s.vimMode}
            onChange={(v) => set({ vimMode: v })}
          />
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
        </Section>
      </div>
    </div>
  );
}
