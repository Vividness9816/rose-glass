/* Phase 8 — pure reducer for the Activity pane's bounded, drop-oldest event ring
   (spec §19.9: ephemeral, never persisted — this is in-memory only). The Rust
   source already scoped + redacted each event (external rows carry no path), so
   this layer is pure presentation state: a capped ring + cumulative health tallies.
   Kept pure (no React) so it unit-tests without the app. */

import type { ActivityEvent } from '../ipc';

export interface ActivityRow {
  id: number; // monotonic UI key
  scope: 'vault' | 'external';
  action: 'read' | 'modify';
  tool: string;
  session: string;
  rel?: string; // present ONLY for in-vault events (external is path-free by construction)
  at: number; // ms timestamp
}

export interface ActivityState {
  rows: ActivityRow[]; // most-recent-first, length <= cap
  seq: number; // next UI id
  vaultCount: number; // cumulative in-vault events seen
  externalCount: number; // cumulative external events seen
  lastAt: number | null; // ms of the most recent event — the liveness signal
  dropped: number; // backend per-tick overflow drops (cumulative, set from activity:dropped)
  anomalies: number; // malformed/unparsable lines (cumulative) — the schema-drift signal
}

/** Ring capacity. ponytail: 200 rows is plenty for an ambient mirror; older rows
    scroll off (not an error — distinct from `dropped`, the backend overflow count). */
export const CAP = 200;

export function emptyActivity(): ActivityState {
  return { rows: [], seq: 0, vaultCount: 0, externalCount: 0, lastAt: null, dropped: 0, anomalies: 0 };
}

/** Ingest one event: prepend a row, trim to `cap`, bump tallies + liveness. Pure —
    returns a new state (older rows beyond `cap` simply fall off the end). */
export function pushActivity(s: ActivityState, ev: ActivityEvent, now: number, cap = CAP): ActivityState {
  const row: ActivityRow = {
    id: s.seq,
    scope: ev.scope,
    action: ev.action,
    tool: ev.tool,
    session: ev.session,
    ...(ev.scope === 'vault' ? { rel: ev.rel } : {}),
    at: now,
  };
  const rows = [row, ...s.rows].slice(0, cap);
  return {
    rows,
    seq: s.seq + 1,
    vaultCount: s.vaultCount + (ev.scope === 'vault' ? 1 : 0),
    externalCount: s.externalCount + (ev.scope === 'external' ? 1 : 0),
    lastAt: now,
    dropped: s.dropped,
    anomalies: s.anomalies,
  };
}

/** Update the backend-reported cumulative drop count (from `activity:dropped`). */
export function setDropped(s: ActivityState, dropped: number): ActivityState {
  return { ...s, dropped };
}

/** Update the backend-reported cumulative anomaly count (from `activity:anomaly`). */
export function setAnomalies(s: ActivityState, anomalies: number): ActivityState {
  return { ...s, anomalies };
}
