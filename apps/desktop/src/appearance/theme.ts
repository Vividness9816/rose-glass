/* Theme: live-switchable + persisted. Theme ids defined ONCE here (§16 —
   a rename is one edit). The CSS lives in tokens.css under [data-theme='...']. */

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'app.theme';
const DEFAULT_THEME: Theme = 'dark';

function isTheme(v: string | null): v is Theme {
  return v === 'dark' || v === 'light';
}

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* persistence is best-effort; the applied theme still holds for the session */
  }
}

export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** Call once at boot: applies the stored theme and returns it. */
export function initTheme(): Theme {
  const theme = getStoredTheme();
  applyTheme(theme);
  return theme;
}
