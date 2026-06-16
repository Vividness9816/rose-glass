/* App shell — the 38px / 1fr / 28px × 52px / 1fr grid (mockup .app-shell).
   Owns theme + graph-data state. Opening a vault swaps the mock graph for the
   real indexer-derived graph and live-refreshes on index events. */

import { useEffect, useState } from 'react';
import { getStoredTheme, toggleTheme, type Theme } from '../appearance/theme';
import type { GraphData } from '../graph/types';
import { payloadToGraphData } from '../graph/fromPayload';
import { GraphPane } from '../graph/GraphPane';
import { Titlebar } from './Titlebar';
import { IconRail } from './IconRail';
import { EditorPane } from './EditorPane';
import { StatusBar } from './StatusBar';
import { getGraphPayload, inTauri, onIndexNote, onIndexRebuilt, openVault } from '../ipc';
import './shell.css';

const MOCK_COUNTS = { notes: 22, links: 48, clusters: 4 };

export function Shell() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [graphData, setGraphData] = useState<GraphData | undefined>(undefined);
  const [vault, setVault] = useState('research-notes');
  const [counts, setCounts] = useState(MOCK_COUNTS);

  const onToggleTheme = () => setThemeState(toggleTheme(theme));

  const refreshGraph = async () => {
    try {
      const payload = await getGraphPayload();
      setGraphData(payloadToGraphData(payload));
      setCounts({ notes: payload.nodes.length, links: payload.edges.length, clusters: 0 });
    } catch {
      /* no vault open / not under Tauri — keep current view */
    }
  };

  const openVaultFlow = async () => {
    if (!inTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir !== 'string') return;
      const res = await openVault(dir);
      const name = res.vault.replace(/\\/g, '/').split('/').filter(Boolean).pop();
      setVault(name ?? res.vault);
      await refreshGraph();
    } catch (e) {
      console.error('open vault failed:', e);
    }
  };

  useEffect(() => {
    if (!inTauri()) return;
    let unNote: (() => void) | undefined;
    let unRebuilt: (() => void) | undefined;
    onIndexNote(() => void refreshGraph())
      .then((u) => (unNote = u))
      .catch(() => {});
    onIndexRebuilt(() => void refreshGraph())
      .then((u) => (unRebuilt = u))
      .catch(() => {});
    return () => {
      unNote?.();
      unRebuilt?.();
    };
  }, []);

  return (
    <div className="app-shell">
      <Titlebar vault={vault} />
      <IconRail />
      <div className="main-area">
        <GraphPane theme={theme} data={graphData} onOpenVault={openVaultFlow} />
        <EditorPane />
      </div>
      <StatusBar
        notes={counts.notes}
        links={counts.links}
        clusters={counts.clusters}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
    </div>
  );
}
