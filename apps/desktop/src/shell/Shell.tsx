/* App shell — owns theme, graph data, and open-note orchestration.
   Opening a vault auto-opens the first note; editing autosaves (debounced) via the
   Rust save path; the watcher reindexes and index events refresh backlinks/meta
   (with an anti-clobber guard so a user's in-progress buffer is never stomped). */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStoredTheme, toggleTheme, type Theme } from '../appearance/theme';
import type { GraphData } from '../graph/types';
import { payloadToGraphData } from '../graph/fromPayload';
import {
  applyEol,
  detectEol,
  type Eol,
  firstNotePath,
  makeDebouncedSaver,
  shouldReloadDoc,
  toLf,
} from '../editor/logic';
import { GraphPane } from '../graph/GraphPane';
import { CommandPalette } from '../command/CommandPalette';
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
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openNotePathRef = useRef<string | null>(null);
  const isDirtyRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null); // disk form (original EOL)
  const eolRef = useRef<Eol>('\n');

  const saver = useMemo(
    () =>
      makeDebouncedSaver(async (p, c) => {
        try {
          await saveNoteFile(p, c);
          // only commit clean/echo state if this note is still the open one
          // (a late save of a switched-away note must not corrupt the new note's state)
          if (openNotePathRef.current === p) {
            lastSavedRef.current = c;
            isDirtyRef.current = false;
          }
        } catch (e) {
          console.error('save failed:', e);
        }
      }, 600),
    [],
  );

  const onToggleTheme = () => setThemeState(toggleTheme(theme));

  // ⌘K / Ctrl+K toggles the command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        const raw = await readNoteFile(path); // disk bytes (strict UTF-8), original EOL
        const [n, bl] = await Promise.all([getNote(path), getBacklinks(path)]);
        openNotePathRef.current = path;
        eolRef.current = detectEol(raw);
        isDirtyRef.current = false;
        lastSavedRef.current = raw;
        setNote(n);
        setBacklinks(bl);
        setDoc(toLf(raw)); // editor works in LF; original EOL re-applied on save
      } catch (e) {
        console.error('open note failed:', e);
      }
    },
    [saver],
  );

  const onChangeDoc = useCallback(
    (text: string) => {
      const p = openNotePathRef.current;
      if (!p) return;
      isDirtyRef.current = true;
      saver.schedule(p, applyEol(text, eolRef.current)); // write with the file's original EOL
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
      // open note was deleted on disk → clear to the empty state
      if (e.op === 'delete') {
        openNotePathRef.current = null;
        isDirtyRef.current = false;
        lastSavedRef.current = null;
        setNote(null);
        setBacklinks([]);
        setDoc('');
        return;
      }
      try {
        const [n, bl] = await Promise.all([getNote(e.path), getBacklinks(e.path)]);
        if (openNotePathRef.current !== e.path) return; // switched notes mid-flight
        setNote(n);
        setBacklinks(bl);
        const disk = await readNoteFile(e.path);
        if (openNotePathRef.current !== e.path) return;
        if (
          shouldReloadDoc({
            eventPath: e.path,
            openPath: openNotePathRef.current,
            isDirty: isDirtyRef.current,
            lastSavedContent: lastSavedRef.current,
            diskContent: disk,
          })
        ) {
          eolRef.current = detectEol(disk);
          lastSavedRef.current = disk;
          setDoc(toLf(disk));
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
      <Titlebar vault={vault} onSearch={() => setPaletteOpen(true)} />
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
      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onOpenNote={openNote} />
      )}
    </div>
  );
}
