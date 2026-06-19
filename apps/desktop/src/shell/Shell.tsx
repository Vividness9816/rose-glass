/* App shell — owns theme, graph data, and open-note orchestration.
   Opening a vault auto-opens the first note; editing autosaves (debounced) via the
   Rust save path; the watcher reindexes and index events refresh backlinks/meta
   (with an anti-clobber guard so a user's in-progress buffer is never stomped). */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
// v2.2: lazy so xterm (eager, heavy) leaves the boot chunk; the terminal is hidden until
// Ctrl+` and only mounted when terminals.length > 0, so this loads on first open — no FMP cost.
const TerminalPane = lazy(() =>
  import('../terminal/TerminalPane').then((m) => ({ default: m.TerminalPane })),
);
// v2.3: lazy so markdown-it (via ReadingView) stays off the boot chunk.
const HelpOverlay = lazy(() => import('./HelpOverlay').then((m) => ({ default: m.HelpOverlay })));
import { isUnattended } from '../terminal/attention';
import { Splitter } from './Splitter';
import { clampFraction, clampPx, nextFraction, TERM_H_DEFAULT, TERM_H_MIN } from './splitLogic';
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
import { Icon } from '../icons/Icon';
import { EditorPane } from './EditorPane';
import { StatusBar } from './StatusBar';
import { NotesPane } from './NotesPane';
import { TagsPane } from './TagsPane';
import { SettingsPane } from './SettingsPane';
import { TabBar } from './TabBar';
import {
  EMPTY_TABS,
  activateTab,
  activeTab,
  closeTab,
  openTab,
  setTabMode,
  type TabKind,
  type TabsState,
} from './tabs';
import { useSettings } from '../settings/SettingsContext';
import { loadSession, saveSession } from './session';
import {
  activityStart,
  activityStop,
  getBacklinks,
  getGraphPayload,
  ingestDroppedFile,
  onOpenFile as onOsOpenFile,
  takePendingOpenFile,
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
  retryEmbeddingModel,
  reindex,
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
  const [helpOpen, setHelpOpen] = useState(false); // v2.3 Help overlay
  const [paletteQuery, setPaletteQuery] = useState<string | undefined>(undefined); // pre-fill (tag search)
  const [terminalOpen, setTerminalOpen] = useState(false); // is the terminal drawer VISIBLE
  const [terminals, setTerminals] = useState<number[]>([]); // open tab ids — each is a live PTY kept alive while hidden
  const [activeTerm, setActiveTerm] = useState(-1);
  const [termNames, setTermNames] = useState<Record<number, string>>({}); // custom tab names
  const [termAttention, setTermAttention] = useState<Set<number>>(() => new Set()); // tabs needing input
  const [editingTerm, setEditingTerm] = useState<number | null>(null); // tab being renamed
  const renameCancelRef = useRef(false); // Esc-cancel flag (blur fires on the unmount, must not commit)
  const nextTermIdRef = useRef(1);
  const activeTermRef = useRef(activeTerm);
  activeTermRef.current = activeTerm;
  const terminalOpenRef = useRef(terminalOpen); // drawer-visible, read inside the mount-once attention path
  terminalOpenRef.current = terminalOpen;
  const [clustering, setClustering] = useState(false); // Phase 11 embed+cluster in progress
  const [clusterError, setClusterError] = useState<string | null>(null); // v2.0 model-load failure → Retry
  const [reindexing, setReindexing] = useState(false); // Settings: manual index rebuild in progress
  const [railView, setRailView] = useState('graph'); // which IconRail view; 'activity' swaps the right pane
  const [activity, setActivity] = useState<ActivityState>(emptyActivity); // Phase 8 ephemeral ring
  const [tailing, setTailing] = useState(false); // is the CC activity tail actually running

  // v2.3 document tabs (ADR-20260619). The single editable buffer + save machinery below stay
  // UNCHANGED; tabsState only tracks WHICH paths are open + the active cursor. Read via refs in
  // the open/activate/close callbacks so those stay referentially stable (IPC subs don't churn).
  const settings = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [tabsState, setTabsState] = useState<TabsState>(EMPTY_TABS);
  const tabsStateRef = useRef(tabsState);
  tabsStateRef.current = tabsState;
  const nextTabIdRef = useRef(1);

  // ── v2.1 resizable layout: graph↔right split fraction + terminal-drawer height. Both
  // restore from session and are CLAMPED on read (splitLogic) so a corrupt persisted value
  // degrades to a default instead of bricking the layout. Drag drives the CSS var
  // imperatively; commit persists once on pointer-up.
  const [splitFraction, setSplitFraction] = useState(() => clampFraction(loadSession().splitFraction ?? 0.5));
  const [terminalHeight, setTerminalHeight] = useState(() =>
    clampPx(loadSession().terminalHeight ?? TERM_H_DEFAULT, TERM_H_DEFAULT, TERM_H_MIN, window.innerHeight - 160),
  );
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const onCommitSplit = useCallback((f: number) => {
    setSplitFraction(f);
    saveSession({ splitFraction: f });
  }, []);
  const onCommitTermHeight = useCallback((h: number) => {
    setTerminalHeight(h);
    saveSession({ terminalHeight: h });
  }, []);
  // Clamp the APPLIED drawer height to the current viewport, so a tall saved value (or a
  // window shrunk since it was saved) can't push the resize edge off-screen and soft-lock it.
  const drawerHeightPx = clampPx(terminalHeight, terminalHeight, TERM_H_MIN, window.innerHeight - 160);

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

  const openPalette = useCallback((query?: string) => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setPaletteQuery(query);
    setPaletteOpen(true);
  }, []);
  // Tags pane → search that tag in the palette.
  const onTag = useCallback((tag: string) => openPalette(tag), [openPalette]);
  // Settings → rebuild the derived index from disk (Markdown untouched).
  const onReindex = useCallback(async () => {
    if (reindexing || !inTauri()) return;
    setReindexing(true);
    try {
      await reindex();
    } catch (e) {
      console.error('reindex failed:', e);
    } finally {
      setReindexing(false);
    }
  }, [reindexing]);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    prevFocusRef.current?.focus?.(); // restore focus so keyboard nav isn't lost
  }, []);

  const addTerminal = useCallback(() => {
    const id = nextTermIdRef.current++;
    setTerminals((ts) => [...ts, id]);
    setActiveTerm(id);
  }, []);

  // Ctrl+`: first press opens a terminal; later presses just hide/show it (the PTYs stay
  // alive while hidden — processes are NOT killed). Only the tab × kills a session.
  const toggleTerminal = useCallback(() => {
    if (terminals.length === 0) {
      addTerminal();
      setTerminalOpen(true);
    } else {
      setTerminalOpen((v) => !v);
    }
  }, [terminals.length, addTerminal]);

  // Close one tab: unmounting its TerminalPane kills that PTY. Switch active to a neighbour;
  // hide the drawer when the last tab closes.
  const closeTerminal = useCallback((id: number) => {
    setTerminals((ts) => {
      const next = ts.filter((t) => t !== id);
      if (next.length === 0) setTerminalOpen(false);
      else if (id === activeTermRef.current) setActiveTerm(next[next.length - 1]);
      return next;
    });
  }, []);

  // Switching to a tab clears its attention flag (you're now looking at it).
  const selectTerm = useCallback((id: number) => {
    setActiveTerm(id);
    setTermAttention((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);
  // A terminal's PTY emitted settled output or rang the bell. Flag it green ONLY if you
  // can't see it right now (isUnattended: not the active tab, or drawer hidden, or window
  // blurred) — the old code flagged background tabs only, so a single focused terminal
  // awaiting a blurred-window Claude run never lit up (the bug the user reported).
  const markTermAttention = useCallback((id: number) => {
    const attended = !isUnattended({
      isActiveTab: id === activeTermRef.current,
      isDrawerVisible: terminalOpenRef.current,
      isWindowFocused: document.hasFocus(),
    });
    if (attended) return; // you're looking at it — nothing to flag
    setTermAttention((s) => {
      if (s.has(id)) return s;
      console.debug(`terminal ${id} → attention (unattended, output settled/bell)`);
      return new Set(s).add(id);
    });
  }, []);
  const commitTermRename = useCallback((id: number, value: string) => {
    const name = value.trim();
    setTermNames((prev) => {
      const next = { ...prev };
      if (name) next[id] = name;
      else delete next[id]; // cleared → fall back to the default "terminal N"
      return next;
    });
    setEditingTerm(null);
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
    setClusterError(null);
    try {
      await recomputeClusters();
    } catch (e) {
      // v2.0: a failed ~90MB model fetch is remembered backend-side; surface a Retry
      // instead of only logging it (the Retry resets the cache then re-attempts).
      console.error('recompute clusters failed:', e);
      setClusterError(String(e));
    } finally {
      setClustering(false);
    }
  }, [clustering]);

  // v2.0 Retry affordance: clear the remembered model-load failure, then re-cluster.
  const onRetryCluster = useCallback(async () => {
    try {
      await retryEmbeddingModel();
    } catch {
      /* reset is best-effort; the re-cluster below reports the real outcome */
    }
    await onCluster();
  }, [onCluster]);

  // ⌘K / Ctrl+K opens the palette; the palette owns its own close (so pressing
  // ⌘K inside it can't bubble here and re-toggle).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openPalette();
      }
      // Ctrl/⌘+` opens the terminal (first press) or hides/shows it (keeps PTYs alive).
      if ((e.ctrlKey || e.metaKey) && e.code === 'Backquote') {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, toggleTerminal]);

  // Clear the active terminal's attention the moment you're looking at it again: when it
  // becomes the active tab, when the drawer opens, or when the window regains focus. The old
  // clear path (selectTerm only) missed the single-terminal / window-blur case.
  useEffect(() => {
    if (!terminalOpen) return;
    const clearActive = () => {
      if (!document.hasFocus()) return;
      setTermAttention((s) => {
        const id = activeTermRef.current;
        if (!s.has(id)) return s;
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    };
    clearActive(); // active-tab change or drawer just opened → clear now
    window.addEventListener('focus', clearActive); // window refocus → clear then
    return () => window.removeEventListener('focus', clearActive);
  }, [activeTerm, terminalOpen]);

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
        await saver.flush(); // persist any pending edit to the previous note first (R3: await before re-read)
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
        saveSession({ notePath: path }); // resume into this note next launch
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

  // v2.3: open a path in a tab (or focus its existing tab), then load the active tab's buffer
  // via the UNCHANGED single-buffer openNote/openBinary (ADR-20260619). Stable identity (reads
  // tabs/settings via refs), so the IPC subscription effects don't re-bind on tab changes.
  const openInTab = useCallback(
    (path: string, kind: TabKind) => {
      const s = settingsRef.current;
      const isNew = !tabsStateRef.current.tabs.some((t) => t.path === path);
      const mode = kind === 'note' ? s.defaultView : 'edit';
      const r = openTab(
        tabsStateRef.current,
        { path, kind, mode },
        nextTabIdRef.current,
        s.alwaysFocusNewTabs,
      );
      if (isNew) nextTabIdRef.current += 1;
      setTabsState(r.state);
      if (r.activate != null) {
        if (kind === 'note') void openNote(path);
        else openBinary(path);
      }
    },
    [openNote, openBinary],
  );

  const activateTabById = useCallback(
    (id: number) => {
      const t = tabsStateRef.current.tabs.find((x) => x.id === id);
      if (!t) return;
      setTabsState(activateTab(tabsStateRef.current, id));
      if (t.kind === 'note') void openNote(t.path);
      else openBinary(t.path);
    },
    [openNote, openBinary],
  );

  const closeTabById = useCallback(
    (id: number) => {
      const r = closeTab(tabsStateRef.current, id);
      setTabsState(r.state);
      if (!r.wasActive) return; // closing a background tab never touches the active buffer
      if (r.activate != null) {
        const t = r.state.tabs.find((x) => x.id === r.activate);
        if (t) {
          // openNote/openBinary flush the closing tab's pending write first (R2)
          if (t.kind === 'note') void openNote(t.path);
          else openBinary(t.path);
        }
      } else {
        // no tabs left → flush the closing tab's pending write (R2), then clear to the empty state
        void saver.flush().then(() => {
          openNotePathRef.current = null;
          isDirtyRef.current = false;
          lastSavedRef.current = null;
          setNote(null);
          setBacklinks([]);
          setDoc('');
          setBinaryPath(null);
        });
      }
    },
    [openNote, openBinary, saver],
  );

  const onToggleMode = useCallback(() => {
    const a = activeTab(tabsStateRef.current);
    if (a) setTabsState((s) => setTabMode(s, a.id, a.mode === 'read' ? 'edit' : 'read'));
  }, []);

  // v2.2: stable callback for a graph node click, so React.memo(GraphPane) isn't defeated by
  // a fresh inline arrow each render (the only GraphPane prop that wasn't already stable).
  const onOpenGraphNode = useCallback(
    (p: string) => {
      setRailView('graph'); // surface the editor for the clicked note
      openInTab(p, 'note');
    },
    [openInTab],
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
      openInTab(rel, kind === 'pdf' || kind === 'docx' ? 'binary' : 'note');
    } catch (e) {
      console.error('open file failed:', e);
    }
  }, [openInTab]);

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
        openInTab(sibling, 'note'); // watcher indexes a new .md → it appears as a graph node
      } catch (e) {
        console.error('edit-as-markdown failed:', e);
      }
    },
    [openInTab],
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
        if (dst) openInTab(dst, 'note');
      } catch (e) {
        console.error('wikilink nav failed:', e);
      }
    },
    [openInTab],
  );

  // Open a vault by absolute path (no dialog). Opens `restoreNote` if it still exists,
  // else the first note. Shared by the Open-vault dialog and the boot session-restore.
  const openVaultByPath = useCallback(
    async (dir: string, restoreNote?: string) => {
      if (!inTauri()) return;
      try {
        const res = await openVault(dir);
        vaultRootRef.current = res.vault; // absolute root, for the Open-file relativizer
        const name = res.vault.replace(/\\/g, '/').split('/').filter(Boolean).pop();
        setVault(name ?? res.vault);
        saveSession({ vaultPath: res.vault });
        const payload = await refreshGraph();
        const paths = new Set(payload?.nodes.map((n) => n.path) ?? []);
        const target =
          restoreNote && paths.has(restoreNote)
            ? restoreNote
            : payload
              ? firstNotePath(payload.nodes)
              : undefined;
        if (target) openInTab(target, 'note');
      } catch (e) {
        console.error('open vault failed:', e);
      }
    },
    [refreshGraph, openInTab],
  );

  const openVaultFlow = useCallback(async () => {
    if (!inTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === 'string') await openVaultByPath(dir);
    } catch (e) {
      console.error('open vault failed:', e);
    }
  }, [openVaultByPath]);

  // v2.2: open a file handed to us by the OS (double-click / "open with"), arriving via the
  // single-instance forward (warm) or the cold-start pending file. If a vault is open, ingest
  // into it (copies outside-vault files into inbox/, exactly like drag-drop); if none is open
  // yet, open the file's own folder AS the vault so it gets indexed + opened in place.
  const openExternalFile = useCallback(
    async (absPath: string) => {
      try {
        if (!vaultRootRef.current) {
          const cut = Math.max(absPath.lastIndexOf('\\'), absPath.lastIndexOf('/'));
          if (cut > 0) await openVaultByPath(absPath.slice(0, cut));
        }
        const r = await ingestDroppedFile(absPath);
        openInTab(r.rel, r.kind === 'note' ? 'note' : 'binary');
      } catch (e) {
        console.error('open external file failed for', absPath, e);
      }
    },
    [openVaultByPath, openInTab],
  );

  // Titlebar "+ New note": create a non-colliding Untitled note at the vault root and open it.
  const onNewNote = useCallback(async () => {
    if (!inTauri() || !vaultRootRef.current) return;
    const existing = new Set((graphData?.nodes ?? []).map((n) => n.path.toLowerCase()));
    let name = 'Untitled.md';
    for (let i = 2; existing.has(name.toLowerCase()); i++) name = `Untitled ${i}.md`;
    try {
      await saveNoteFile(name, '# Untitled\n\n');
      setRailView('graph');
      openInTab(name, 'note');
    } catch (e) {
      console.error('new note failed:', e);
    }
  }, [graphData, openInTab]);

  // Titlebar "↗ Share": reveal the vault folder in the OS file explorer (export affordance,
  // distinct from the editor-header note-level Copy-as-Markdown).
  const onRevealVault = useCallback(async () => {
    const root = vaultRootRef.current;
    if (!root || !inTauri()) return;
    try {
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(root);
    } catch (e) {
      console.error('reveal vault failed:', e);
    }
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    let unNote: (() => void) | undefined;
    let unRebuilt: (() => void) | undefined;
    onIndexNote(async (e) => {
      void refreshGraph();
      // v2.3: a deleted note drops its tab (active or background). For the ACTIVE note the buffer
      // is also cleared below; activeId → null keeps the empty buffer consistent with no active tab.
      if (e.op === 'delete') {
        setTabsState((s) => {
          const tab = s.tabs.find((t) => t.path === e.path);
          if (!tab) return s;
          return {
            tabs: s.tabs.filter((t) => t.id !== tab.id),
            activeId: s.activeId === tab.id ? null : s.activeId,
          };
        });
      }
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

  // v2.0: drag a file onto the window → ingest it (copy into inbox/ if outside the vault,
  // index md/txt so an orphan node appears) and open it in the right pane. Uses Tauri's
  // native webview drag-drop (real absolute paths; HTML5 dnd can't provide them).
  useEffect(() => {
    if (!inTauri()) return;
    let active = true;
    let un: (() => void) | undefined;
    void (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const u = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop') return;
        let opened = false;
        for (const p of event.payload.paths) {
          try {
            const r = await ingestDroppedFile(p);
            // Open only the first successfully-ingested file; the rest still get indexed.
            if (!opened) {
              openInTab(r.rel, r.kind === 'note' ? 'note' : 'binary');
              opened = true;
            }
          } catch (e) {
            console.error('drop ingest failed for', p, e); // ponytail: surface as a toast later
          }
        }
      });
      if (active) un = u;
      else u();
    })();
    return () => {
      active = false;
      un?.();
    };
  }, [openInTab]);

  // v2.2: a file opened from the OS while we're ALREADY running — the single-instance plugin
  // forwarded it (focus + open-file event). Reuse the same ingest/open path as drag-drop.
  useEffect(() => {
    if (!inTauri()) return;
    let active = true;
    let un: (() => void) | undefined;
    onOsOpenFile((path) => void openExternalFile(path))
      .then((u) => (active ? (un = u) : u()))
      .catch(() => {});
    return () => {
      active = false;
      un?.();
    };
  }, [openExternalFile]);

  // Persist the active rail view so the app resumes on the same pane.
  useEffect(() => {
    saveSession({ railView });
  }, [railView]);

  // Boot: resume into the last vault + note + view (theme restores via initTheme). Best-
  // effort — a missing/moved vault just lands on the empty state. Runs once.
  useEffect(() => {
    if (!inTauri()) return;
    const s = loadSession();
    if (s.railView) setRailView(s.railView);
    void (async () => {
      if (s.vaultPath) await openVaultByPath(s.vaultPath, s.notePath);
      // Cold start: a file this instance was launched with (double-clicked before running).
      // Sequenced AFTER restore so there's a vault to ingest into (else openExternalFile opens
      // the file's own folder as the vault).
      const pending = await takePendingOpenFile();
      if (pending) await openExternalFile(pending);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once on mount
  }, []);

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
        onSearch={() => openPalette()}
        onOpenFile={() => void onOpenFile()}
        onShare={() => void onRevealVault()}
        onNewNote={() => void onNewNote()}
        canOpenFile={graphData !== undefined}
      />
      <IconRail
        active={railView}
        onSelect={(id) => (id === 'search' ? openPalette() : setRailView(id))}
      />
      <div
        className="main-area"
        ref={mainAreaRef}
        style={{ ['--rg-split']: String(splitFraction) } as CSSProperties}
      >
        <GraphPane
          theme={theme}
          data={graphData}
          onOpenVault={openVaultFlow}
          onCluster={onCluster}
          clustering={clustering}
          clusterError={clusterError}
          onRetryCluster={onRetryCluster}
          pulseRef={graphPulseRef}
          onOpenNode={onOpenGraphNode}
        />
        {railView === 'activity' ? (
          <ActivityPane state={activity} tailing={tailing} vaultOpen={graphData !== undefined} />
        ) : railView === 'notes' ? (
          <NotesPane
            notes={(graphData?.nodes ?? []).map((n) => ({ path: n.path, title: n.name }))}
            activePath={note?.path ?? null}
            onOpen={(p) => {
              setRailView('graph');
              openInTab(p, 'note');
            }}
          />
        ) : railView === 'tags' ? (
          <TagsPane onTag={onTag} />
        ) : railView === 'settings' ? (
          <SettingsPane
            theme={theme}
            onToggleTheme={onToggleTheme}
            vault={vault}
            onReindex={() => void onReindex()}
            reindexing={reindexing}
            onHelp={() => setHelpOpen(true)}
          />
        ) : (
          <div className="editor-with-tabs">
            <TabBar
              tabs={tabsState.tabs}
              activeId={tabsState.activeId}
              onActivate={activateTabById}
              onClose={closeTabById}
            />
            <EditorPane
              note={note}
              doc={doc}
              backlinks={backlinks}
              binaryPath={binaryPath}
              mode={activeTab(tabsState)?.mode ?? 'edit'}
              onToggleMode={onToggleMode}
              onChangeDoc={onChangeDoc}
              onOpenPath={(p) => openInTab(p, 'note')}
              onWikiClick={onWikiClick}
              onEditAsMarkdown={onEditAsMarkdown}
            />
          </div>
        )}
        <Splitter
          axis="x"
          containerRef={mainAreaRef}
          varName="--rg-split"
          compute={(x, rect) => nextFraction(x - rect.left, rect.width)}
          format={(f) => String(f)}
          onCommit={onCommitSplit}
          ariaLabel="Resize graph and editor panes"
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
        <CommandPalette
          onClose={closePalette}
          // surface the editor for the picked note — the palette can be opened from a
          // non-graph rail (tag-click → tags pane, search rail, notes/settings/activity),
          // where opening a note behind the current pane reads as "click does nothing".
          onOpenNote={(p) => {
            setRailView('graph');
            openInTab(p, 'note');
          }}
          initialQuery={paletteQuery}
        />
      )}
      {helpOpen && (
        <Suspense fallback={null}>
          <HelpOverlay onClose={() => setHelpOpen(false)} />
        </Suspense>
      )}
      {/* Once opened, the drawer stays MOUNTED so its PTYs keep running; Ctrl+` just
          hides it (display:none). Each tab is a keyed TerminalPane — only the active one
          shows, the rest stay alive hidden. The tab × unmounts → kills that PTY. */}
      {terminals.length > 0 && (
        <div
          className="terminal-drawer"
          ref={drawerRef}
          style={
            { display: terminalOpen ? 'flex' : 'none', ['--rg-term-h']: `${drawerHeightPx}px` } as CSSProperties
          }
        >
          <Splitter
            axis="y"
            containerRef={drawerRef}
            varName="--rg-term-h"
            compute={(y, rect) => clampPx(rect.bottom - y, terminalHeight, TERM_H_MIN, window.innerHeight - 160)}
            format={(px) => `${px}px`}
            onCommit={onCommitTermHeight}
            ariaLabel="Resize terminal height"
          />
          <div className="terminal-header">
            <div className="terminal-tabs">
              {terminals.map((id, i) => (
                <div
                  key={id}
                  className={`terminal-tab${id === activeTerm ? ' active' : ''}`}
                  onClick={() => selectTerm(id)}
                >
                  <span
                    className={`terminal-dot${termAttention.has(id) ? ' attn' : ''}`}
                    title={termAttention.has(id) ? 'Waiting for input' : undefined}
                  />
                  {editingTerm === id ? (
                    <input
                      className="terminal-tab-rename"
                      defaultValue={termNames[id] ?? `terminal ${i + 1}`}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitTermRename(id, e.currentTarget.value);
                        else if (e.key === 'Escape') {
                          renameCancelRef.current = true; // discard: the unmount's blur must not commit
                          setEditingTerm(null);
                        }
                      }}
                      onBlur={(e) => {
                        if (renameCancelRef.current) {
                          renameCancelRef.current = false;
                          setEditingTerm(null);
                          return;
                        }
                        commitTermRename(id, e.currentTarget.value);
                      }}
                    />
                  ) : (
                    <span
                      className="terminal-tab-label"
                      title="Double-click to rename"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingTerm(id);
                      }}
                    >
                      {termNames[id] ?? `terminal ${i + 1}`}
                    </span>
                  )}
                  <button
                    className="terminal-tab-close"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(id);
                    }}
                    title="Close terminal (ends its process)"
                    aria-label={`Close terminal ${i + 1}`}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
              <button
                className="terminal-tab-add"
                type="button"
                onClick={addTerminal}
                title="New terminal"
                aria-label="New terminal"
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
            <button
              className="terminal-close"
              type="button"
              onClick={() => setTerminalOpen(false)}
              title="Hide terminal (Ctrl+`) — keeps it running"
              aria-label="Hide terminal"
            >
              <Icon name="chevronDown" size={13} />
            </button>
          </div>
          <div className="terminal-body">
            <Suspense fallback={null}>
              {terminals.map((id) => (
                <div
                  key={id}
                  className="terminal-tabpane"
                  style={{ display: id === activeTerm ? 'flex' : 'none' }}
                >
                  <TerminalPane theme={theme} onAttention={() => markTermAttention(id)} />
                </div>
              ))}
            </Suspense>
          </div>
        </div>
      )}
    </div>
    </>
  );
}
