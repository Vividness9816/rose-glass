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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  </React.StrictMode>,
);
