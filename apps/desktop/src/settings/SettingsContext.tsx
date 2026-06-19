import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';

const SettingsCtx = createContext<Settings>(DEFAULT_SETTINGS);
const SetSettingsCtx = createContext<(patch: Partial<Settings>) => void>(() => {});

/** Provides app settings + a patch fn. Seeds from localStorage once; persists on change.
    Wraps <Shell/> so CodeMirrorHost and SettingsPane consume via the hooks below. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...p };
      saveSettings(next);
      return next;
    });
  }, []);
  const value = useMemo(() => settings, [settings]);
  return (
    <SettingsCtx.Provider value={value}>
      <SetSettingsCtx.Provider value={patch}>{children}</SetSettingsCtx.Provider>
    </SettingsCtx.Provider>
  );
}

export const useSettings = () => useContext(SettingsCtx);
export const useSetSettings = () => useContext(SetSettingsCtx);
