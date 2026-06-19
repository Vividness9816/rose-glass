/* Session persistence — reopen the app where you left off: same vault, note, and rail
   view. Theme persists separately (appearance/theme.ts). localStorage only; a missing
   or moved vault degrades to a clean start (the restore is best-effort). */

const KEY = 'app.session';

export interface Session {
  vaultPath?: string;
  notePath?: string; // vault-relative
  railView?: string;
  splitFraction?: number; // graph↔right split, 0..1 — clamped on read in Shell (splitLogic)
  terminalHeight?: number; // drawer height in px — clamped on read in Shell (splitLogic)
}

export function loadSession(): Session {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : {};
  } catch {
    return {};
  }
}

/** Merge a patch into the stored session (best-effort; never throws). */
export function saveSession(patch: Partial<Session>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadSession(), ...patch }));
  } catch {
    /* private mode / quota — the app still works, it just won't resume */
  }
}
