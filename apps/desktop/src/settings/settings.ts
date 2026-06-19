/* App settings — persisted to localStorage, merged over defaults (forward-compatible),
   mirroring graph/config.ts. Pure: no React, no IPC. Editor toggles are consumed by
   CodeMirrorHost via compartments; the two tab-dependent fields are stored now but only
   take effect once tabs (leg 4) + reading mode (leg 3) land. */

export interface Settings {
  // Editor — tab-dependent (stored now; wired in legs 3/4)
  alwaysFocusNewTabs: boolean;
  defaultView: 'edit' | 'read';
  // Behavior
  spellcheck: boolean;
  autoPairBrackets: boolean;
  autoPairMarkdown: boolean;
  smartLists: boolean;
  indentWithTabs: boolean;
  // Advanced
  convertHtmlPaste: boolean;
  vimMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  alwaysFocusNewTabs: true,
  defaultView: 'edit',
  spellcheck: true,
  autoPairBrackets: true,
  autoPairMarkdown: true,
  smartLists: true,
  indentWithTabs: true, // matches the editor's current indentWithTab behavior
  convertHtmlPaste: true,
  vimMode: false,
};

const KEY = 'rose-glass:settings';

/** Pure merge of a parsed/unknown value over the defaults (forward-compatible: unknown
    keys are ignored by consumers, missing keys keep their default). Exposed for testing
    without a DOM/localStorage. */
export function mergeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
  const p = raw as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...p,
    // enum guard: anything but 'read' resolves to the default 'edit'
    defaultView: p.defaultView === 'read' ? 'read' : DEFAULT_SETTINGS.defaultView,
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return mergeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist this session */
  }
}
