/* App shell — the 38px / 1fr / 28px × 52px / 1fr grid (mockup .app-shell).
   Owns theme state; the graph + statusbar consume it. */

import { useState } from 'react';
import { getStoredTheme, toggleTheme, type Theme } from '../appearance/theme';
import { GraphPane } from '../graph/GraphPane';
import { Titlebar } from './Titlebar';
import { IconRail } from './IconRail';
import { EditorPane } from './EditorPane';
import { StatusBar } from './StatusBar';
import './shell.css';

export function Shell() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const onToggleTheme = () => {
    setThemeState(toggleTheme(theme));
  };

  return (
    <div className="app-shell">
      <Titlebar vault="research-notes" />
      <IconRail />
      <div className="main-area">
        <GraphPane theme={theme} />
        <EditorPane />
      </div>
      <StatusBar
        notes={22}
        links={48}
        clusters={4}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
    </div>
  );
}
