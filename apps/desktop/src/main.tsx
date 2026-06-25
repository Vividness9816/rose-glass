import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './tokens/tokens.css';
import './styles/global.css';
import { initTheme } from './appearance/theme';
import { Shell } from './shell/Shell';
import { SettingsProvider } from './settings/SettingsContext';

initTheme(); // apply persisted theme before first paint

// Cursor-tracked border glow on action buttons (reactbits BorderGlow, button-scaled): one
// delegated listener sets --gx/--gy on the hovered button; the glow ring itself is pure CSS
// (shell.css). ponytail: one passive listener for every button beats per-button wiring; it only
// does work when the pointer is actually over a glow button (the closest() short-circuits).
document.addEventListener(
  'pointermove',
  (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.gc-btn, .tb-btn, .ea-btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--gx', `${e.clientX - r.left}px`);
    btn.style.setProperty('--gy', `${e.clientY - r.top}px`);
  },
  { passive: true },
);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  </React.StrictMode>,
);
