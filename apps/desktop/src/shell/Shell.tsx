/* App shell — owns theme, graph data, and open-note orchestration.
   Opening a vault auto-opens the first note; editing autosaves (debounced) via the
   Rust save path; the watcher reindexes and index events refresh backlinks/meta
   (with an anti-clobber guard so a user's in-progress buffer is never stomped). */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStoredTheme, toggleTheme, type Theme } from '../appearance/theme';
import type { GraphData } from '../graph/types';
import { payloadToGraphData } from '../graph/fromPayload';
import { firstNotePath, makeDebouncedSaver, shouldReloadDoc } from '../editor/logic';
import { GraphPane } from '../graph/GraphPane';
import { Titlebar } from './Titlebar';
import { IconRail } from './IconRail';
import { EditorPane } from './EditorPane';
import { StatusBar } from './StatusBar';
import {
  getBacklinks,
  getGraphPayload,
  getNote,
  inTauri,
  onIndexNote,
  onIndexRebuilt,
  openVault,
  readNoteFile,
  resolveLink,
  saveNoteFile,
  type BacklinkDto,
  type GraphPayload,
  type NoteDto,
} from '../ipc';
import './shell.css';

const MOCK_COUNTS = { notes: 22, links: 48, clusters: 4 };

export function Shell() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [graphData, setGraphData] = useState<GraphData | undefined>(undefined);
  const [vault, setVault] = useState('research-notes');
  const [counts, setCounts] = useState(MOCK_COUNTS);
  const [note, setNote] = useState<NoteDto | null>(null);
  const [backlinks, setBacklinks] = useState<BacklinkDto[]>([]);
  const [doc, setDoc] = useState('');

  const openNotePathRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null);

  const saver = useMemo(
    () =>
      makeDebouncedSaver(async (p, c) => {
        try {
          await saveNoteFile(p, c);
          lastSavedRef.current = c;
          isDirtyRef.current = false;
        } catch (e) {
          console.error('save failed:', e);
        }
      }, 600),
    [],
  );

  const onToggleTheme = () => setThemeState(toggleTheme(theme));

  const refreshGraph = useCallback(async (): Promise<GraphPayload | null> => {
    try {
      const payload = await getGraphPayload();
      setGraphData(payloadToGraphData(payload));
      setCounts({ notes: payload.nodes.length, links: payload.edges.length, clusters: 0 });
      return payload;
    } catch {
      return null;
    }
  }, []);

  const openNote = useCallback(
    async (path: string) => {
      try {
        saver.flush(); // persist any pending edit to the previous note first
        const content = await readNoteFile(path);
        const [n, bl] = await Promise.all([getNote(path), getBacklinks(path)]);
        openNotePathRef.current = path;
        isDirtyRef.current = false;
        lastSavedRef.current = content;
        setNote(n);
        setBacklinks(bl);
        setDoc(content);
      } catch (e) {
        console.error('open note failed:', e);
      }
    },
    [saver],
  );

  const onChangeDoc = useCallback(
    (text: string) => {
      if (!openNotePathRef.current) return;
      isDirtyRef.current = true;
      saver.schedule(openNotePathRef.current, text);
    },
    [saver],
  );

  const onWikiClick = useCallback(
    async (target: string) => {
      try {
        const dst = await resolveLink(target, openNotePathRef.current ?? '');
        if (dst) await openNote(dst);
      } catch (e) {
        console.error('wikilink nav failed:', e);
      }
    },
    [openNote],
  );

  const openVaultFlow = useCallback(async () => {
    if (!inTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir !== 'string') return;
      const res = await openVault(dir);
      const name = res.vault.replace(/\\/g, '/').split('/').filter(Boolean).pop();
      setVault(name ?? res.vault);
      const payload = await refreshGraph();
      const first = payload ? firstNotePath(payload.nodes) : undefined;
      if (first) await openNote(first);
    } catch (e) {
      console.error('open vault failed:', e);
    }
  }, [refreshGraph, openNote]);

  useEffect(() => {
    if (!inTauri()) return;
    let unNote: (() => void) | undefined;
    let unRebuilt: (() => void) | undefined;
    onIndexNote(async (e) => {
      void refreshGraph();
      if (e.path !== openNotePathRef.current) return;
      try {
        const [n, bl] = await Promise.all([getNote(e.path), getBacklinks(e.path)]);
        setNote(n);
        setBacklinks(bl);
        const disk = await readNoteFile(e.path);
        if (
          shouldReloadDoc({
            eventPath: e.path,
            openPath: openNotePathRef.current,
            isDirty: isDirtyRef.current,
            lastSavedContent: lastSavedRef.current,
            diskContent: disk,
          })
        ) {
          lastSavedRef.current = disk;
          setDoc(disk);
        }
      } catch (err) {
        console.error('index refresh failed:', err);
      }
    })
      .then((u) => (unNote = u))
      .catch(() => {});
    onIndexRebuilt(() => void refreshGraph())
      .then((u) => (unRebuilt = u))
      .catch(() => {});
    return () => {
      unNote?.();
      unRebuilt?.();
    };
  }, [refreshGraph]);

  return (
    <div className="app-shell">
      <Titlebar vault={vault} />
      <IconRail />
      <div className="main-area">
        <GraphPane theme={theme} data={graphData} onOpenVault={openVaultFlow} />
        <EditorPane
          note={note}
          doc={doc}
          backlinks={backlinks}
          onChangeDoc={onChangeDoc}
          onOpenPath={openNote}
          onWikiClick={onWikiClick}
        />
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
