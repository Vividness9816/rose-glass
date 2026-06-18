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
import { editorKind } from '../editor/editorKind';
import { siblingMdPath, toVaultRelative } from '../editor/fileOpen';
import { GraphPane } from '../graph/GraphPane';
import { Backdrop } from '../backdrop/Backdrop';
import { TerminalPane } from '../terminal/TerminalPane';
import { CommandPalette } from '../command/CommandPalette';
import { ActivityPane } from '../activity/ActivityPane';
import {
  emptyActivity,
  pushActivity,
  setAnomalies,
  setDropped,
  type ActivityState,
} from '../activity/ring';
import { Titlebar } from './Titlebar';
import { IconRail } from './IconRail';
import { EditorPane } from './EditorPane';
import { StatusBar } from './StatusBar';
import {
  activityStart,
  activityStop,
  getBacklinks,
  getGraphPayload,
  getNote,
  inTauri,
  onActivityAnomaly,
  onActivityDropped,
  onActivityEvent,
  onIndexNote,
  onIndexRebuilt,
  openVault,
  readNoteFile,
  recomputeClusters,
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
  const [binaryPath, setBinaryPath] = useState<string | null>(null); // Phase 9: open pdf/docx (not an indexed note)
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false); // Ctrl+` toggles the terminal drawer
  const [clustering, setClustering] = useState(false); // Phase 11 embed+cluster in progress
  const [railView, setRailView] = useState('graph'); // which IconRail view; 'activity' swaps the right pane
  const [activity, setActivity] = useState<ActivityState>(emptyActivity); // Phase 8 ephemeral ring
  const [tailing, setTailing] = useState(false); // is the CC activity tail actually running

  // Phase 8: Shell calls this to light up a node on CC activity; GraphPane fills it
  // with a closure over the live renderer (survives data-driven renderer rebuilds).
  const graphPulseRef = useRef<((rel: string, action: 'read' | 'modify') => void) | null>(null);
  // Monotonic token bumped per activity-effect run; serializes start↔stop so a
  // StrictMode/rapid-toggle stale stop can't drop a newer start's tail watcher.
  const activityGenRef = useRef(0);

  const openNotePathRef = useRef<string | null>(null);
  const vaultRootRef = useRef<string | null>(null); // absolute vault root, for relativizing Open-file picks
  const isDirtyRef = useRef(false);
  const lastSavedRef = useRef<string | null>(null); // disk form (original EOL)
  const eolRef = useRef<Eol>('\n');
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const openPalette = useCallback(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    prevFocusRef.current?.focus?.(); // restore focus so keyboard nav isn't lost
  }, []);

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

  // Phase 11: embed + cluster all notes; the emitted index:rebuilt refetches + recolours the graph.
  const onCluster = useCallback(async () => {
    if (clustering || !inTauri()) return;
    setClustering(true);
    try {
      await recomputeClusters();
    } catch (e) {
      console.error('recompute clusters failed:', e);
    } finally {
      setClustering(false);
    }
  }, [clustering]);

  // ⌘K / Ctrl+K opens the palette; the palette owns its own close (so pressing
  // ⌘K inside it can't bubble here and re-toggle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openPalette();
      }
      // Ctrl/⌘+` toggles the terminal drawer (VSCode-style).
      if ((e.ctrlKey || e.metaKey) && e.code === 'Backquote') {
        e.preventDefault();
        setTerminalOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);

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
        setBinaryPath(null); // opening a note leaves any pdf/docx view
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

  // Phase 9: open a non-markdown binary (pdf/docx). It is NOT an indexed note, so there
  // is no autosave target — clear the note buffer and show the view engine.
  const openBinary = useCallback(
    (rel: string) => {
      saver.flush(); // persist any pending edit to the previous note first
      openNotePathRef.current = null;
      isDirtyRef.current = false;
      lastSavedRef.current = null;
      setNote(null);
      setBacklinks([]);
      setDoc('');
      setBinaryPath(rel);
      setRailView('graph'); // surface the editor pane (not the activity pane)
    },
    [saver],
  );

  // Phase 9: "Open file…" — pick any file via the dialog and route by extension. The file
  // must live inside the open vault (the IPC + safe_join contract is vault-relative); a
  // markdown/txt pick opens as a note, a pdf/docx as a binary view.
  const onOpenFile = useCallback(async () => {
    if (!inTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const sel = await open({
        multiple: false,
        defaultPath: vaultRootRef.current ?? undefined,
        filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] }],
      });
      if (typeof sel !== 'string') return;
      const root = vaultRootRef.current;
      const rel = root ? toVaultRelative(sel, root) : null;
      if (!rel) {
        console.error('file must be inside the open vault:', sel); // ponytail: surface in-UI later
        return;
      }
      const kind = editorKind(rel);
      if (kind === 'pdf' || kind === 'docx') openBinary(rel);
      else await openNote(rel);
    } catch (e) {
      console.error('open file failed:', e);
    }
  }, [openBinary, openNote]);

  // Phase 9 / docx B1: extract the .docx to a sibling markdown file and open it. The .docx
  // is never mutated; the sibling .md flows through the normal save + indexer path.
  const onEditAsMarkdown = useCallback(
    async (docxPath: string, markdown: string) => {
      const sibling = siblingMdPath(docxPath);
      try {
        // NEVER clobber an existing sibling: once extracted, report.docx.md is a real,
        // hand-editable note. Re-extracting would silently destroy the user's edits
        // (the lossless-writes invariant covers the sibling .md too). So if it already
        // exists on disk, just open it; only the FIRST extraction writes.
        let exists = false;
        try {
          await readNoteFile(sibling);
          exists = true;
        } catch {
          exists = false; // not found (or unreadable) → safe to create
        }
        if (!exists) await saveNoteFile(sibling, markdown);
        await openNote(sibling); // watcher indexes a new .md → it appears as a graph node
      } catch (e) {
        console.error('edit-as-markdown failed:', e);
      }
    },
    [openNote],
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
      vaultRootRef.current = res.vault; // absolute root, for the Open-file relativizer
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

  // Phase 8: while the Activity view is open, tail CC sessions (read-only, ADR-20260617
  // M1). In-vault events pulse their node (read=violet/modify=rose); all events list in
  // the pane. Stopping the view drops the tail — ephemeral, nothing persisted (§19.9).
  useEffect(() => {
    if (railView !== 'activity' || !inTauri()) return;
    const generation = (activityGenRef.current += 1);
    let unEv: (() => void) | undefined;
    let unDrop: (() => void) | undefined;
    let unAnom: (() => void) | undefined;
    let cancelled = false;
    activityStart(generation)
      .then(() => {
        if (!cancelled) setTailing(true);
      })
      .catch((e) => console.error('activity start failed:', e));
    onActivityEvent((ev) => {
      setActivity((s) => pushActivity(s, ev, Date.now()));
      if (ev.scope === 'vault') graphPulseRef.current?.(ev.rel, ev.action);
    })
      .then((u) => (cancelled ? u() : (unEv = u)))
      .catch(() => {});
    onActivityDropped((n) => setActivity((s) => setDropped(s, n)))
      .then((u) => (cancelled ? u() : (unDrop = u)))
      .catch(() => {});
    onActivityAnomaly((n) => setActivity((s) => setAnomalies(s, n)))
      .then((u) => (cancelled ? u() : (unAnom = u)))
      .catch(() => {});
    return () => {
      cancelled = true;
      setTailing(false);
      unEv?.();
      unDrop?.();
      unAnom?.();
      activityStop(generation).catch(() => {});
    };
  }, [railView]);

  return (
    <>
    <Backdrop theme={theme} />
    <div className="app-shell">
      <Titlebar
        vault={vault}
        onSearch={openPalette}
        onOpenFile={() => void onOpenFile()}
        canOpenFile={graphData !== undefined}
      />
      <IconRail
        active={railView}
        onSelect={(id) => (id === 'search' ? openPalette() : setRailView(id))}
      />
      <div className="main-area">
        <GraphPane
          theme={theme}
          data={graphData}
          activePath={note?.path ?? null}
          onOpenVault={openVaultFlow}
          onCluster={onCluster}
          clustering={clustering}
          pulseRef={graphPulseRef}
          onOpenNode={(p) => {
            setRailView('graph'); // surface the editor for the clicked note
            void openNote(p);
          }}
        />
        {railView === 'activity' ? (
          <ActivityPane state={activity} tailing={tailing} vaultOpen={graphData !== undefined} />
        ) : (
          <EditorPane
            note={note}
            doc={doc}
            backlinks={backlinks}
            binaryPath={binaryPath}
            onChangeDoc={onChangeDoc}
            onOpenPath={openNote}
            onWikiClick={onWikiClick}
            onEditAsMarkdown={onEditAsMarkdown}
          />
        )}
      </div>
      <StatusBar
        notes={counts.notes}
        links={counts.links}
        clusters={counts.clusters}
        theme={theme}
        onToggleTheme={onToggleTheme}
      />
      {paletteOpen && <CommandPalette onClose={closePalette} onOpenNote={openNote} />}
      {terminalOpen && (
        <div className="terminal-drawer">
          <div className="terminal-header">
            <span className="terminal-dot" />
            <span className="terminal-title">terminal — {vault}</span>
            <button
              className="terminal-close"
              type="button"
              onClick={() => setTerminalOpen(false)}
              title="Close terminal (Ctrl+`)"
              aria-label="Close terminal"
            >
              ✕
            </button>
          </div>
          <TerminalPane theme={theme} />
        </div>
      )}
    </div>
    </>
  );
}
