/* Phase 8 — Activity pane (A6). Streams CC sessions: in-vault read/modify light up
   graph nodes (handled in Shell via the renderer) and list here; external sessions
   show MUTED with no path (the event has none — redacted at the Rust source). The
   health row makes a silently-dead tail visible (liveness) — a privacy mirror that
   dies quietly is worse than none. Presentational only; state lives in Shell. */

import { useEffect, useState } from 'react';
import type { ActivityState } from './ring';
import { Icon } from '../icons/Icon';
import './activity.css';

function basename(rel: string): string {
  return rel.split('/').pop() || rel;
}

function liveness(lastAt: number | null, now: number): { label: string; cls: string } {
  if (lastAt === null) return { label: 'waiting for activity', cls: 'idle' };
  const ago = Math.max(0, Math.round((now - lastAt) / 1000));
  if (ago <= 3) return { label: 'live', cls: 'live' };
  if (ago < 120) return { label: `last event ${ago}s ago`, cls: 'live' };
  return { label: `idle ${Math.round(ago / 60)}m`, cls: 'stale' };
}

export function ActivityPane({
  state,
  tailing,
  vaultOpen,
}: {
  state: ActivityState;
  tailing: boolean;
  vaultOpen: boolean;
}) {
  // Tick once a second so the relative liveness label stays honest while mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const live = liveness(state.lastAt, now);
  const empty = vaultOpen
    ? 'Watching Claude Code sessions. Reads and edits appear here as they happen.'
    : 'Open a vault so in-vault activity lights up nodes. External sessions still show, muted.';

  return (
    <div className="activity-pane">
      <div className="activity-header">
        <span className="activity-glyph">
          <Icon name="activity" size="sm" />
        </span>
        <span className="activity-title">claude activity</span>
      </div>
      <div className="activity-health" role="status" aria-live="polite">
        <span className={`ah-dot ${tailing ? live.cls : 'stale'}`}>●</span>
        <span className="ah-state">{tailing ? live.label : 'tail stopped'}</span>
        <span className="ah-sep">·</span>
        <span>{state.vaultCount} in-vault</span>
        <span className="ah-sep">·</span>
        <span>{state.externalCount} external</span>
        {state.dropped > 0 && (
          <>
            <span className="ah-sep">·</span>
            <span className="ah-drop" title="events dropped by the backend overflow cap">
              {state.dropped} dropped
            </span>
          </>
        )}
        {state.anomalies > 0 && (
          <>
            <span className="ah-sep">·</span>
            <span
              className="ah-drop"
              title="malformed/unparsable transcript lines — possible Claude Code format change"
            >
              {state.anomalies} drift
            </span>
          </>
        )}
      </div>
      <div className="activity-list">
        {state.rows.length === 0 ? (
          <div className="activity-empty">{empty}</div>
        ) : (
          state.rows.map((r) => (
            <div key={r.id} className={`activity-row ${r.scope} ${r.action}`}>
              <span className="ar-kind" aria-hidden="true" />
              <span className="ar-tool">{r.tool}</span>
              {r.scope === 'vault' && r.rel ? (
                <span className="ar-path" title={r.rel}>
                  {basename(r.rel)}
                </span>
              ) : (
                <span className="ar-ext">external session</span>
              )}
              <span className="ar-session">{r.session}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
