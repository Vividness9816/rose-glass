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
import { NotesPane } from './NotesPane';
import { TagsPane } from './TagsPane';
import { SettingsPane } from './SettingsPane';
import { loadSession, saveSession } from './session';
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
  const [clustering, setClustering] = useState(false); // Phase 11 embed+cluster in progress
  const [reindexing, setReindexing] = useState(false); // Settings: manual index rebuild in progress
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
  // A background tab's PTY rang the bell (e.g. Claude Code awaiting input) → flag it green.
  const markTermAttention = useCallback((id: number) => {
    if (id === activeTermRef.current) return; // already focused — nothing to flag
    setTermAttention((s) => (s.has(id) ? s : new Set(s).add(id)));
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
      // Ctrl/⌘+` opens the terminal (first press) or hides/shows it (keeps PTYs alive).
      if ((e.ctrlKey || e.metaKey) && e.code === 'Backquote') {
        e.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette, toggleTerminal]);

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
        if (target) await openNote(target);
      } catch (e) {
        console.error('open vault failed:', e);
      }
    },
    [refreshGraph, openNote],
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

  // Titlebar "+ New note": create a non-colliding Untitled note at the vault root and open it.
  const onNewNote = useCallback(async () => {
    if (!inTauri() || !vaultRootRef.current) return;
    const existing = new Set((graphData?.nodes ?? []).map((n) => n.path.toLowerCase()));
    let name = 'Untitled.md';
    for (let i = 2; existing.has(name.toLowerCase()); i++) name = `Untitled ${i}.md`;
    try {
      await saveNoteFile(name, '# Untitled\n\n');
      setRailView('graph');
      await openNote(name);
    } catch (e) {
      console.error('new note failed:', e);
    }
  }, [graphData, openNote]);

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
    if (s.vaultPath) void openVaultByPath(s.vaultPath, s.notePath);
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
        ) : railView === 'notes' ? (
          <NotesPane
            notes={(graphData?.nodes ?? []).map((n) => ({ path: n.path, title: n.name }))}
            activePath={note?.path ?? null}
            onOpen={(p) => {
              setRailView('graph');
              void openNote(p);
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
          />
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
      {paletteOpen && (
        <CommandPalette
          onClose={closePalette}
          // surface the editor for the picked note — the palette can be opened from a
          // non-graph rail (tag-click → tags pane, search rail, notes/settings/activity),
          // where opening a note behind the current pane reads as "click does nothing".
          onOpenNote={(p) => {
            setRailView('graph');
            void openNote(p);
          }}
          initialQuery={paletteQuery}
        />
      )}
      {/* Once opened, the drawer stays MOUNTED so its PTYs keep running; Ctrl+` just
          hides it (display:none). Each tab is a keyed TerminalPane — only the active one
          shows, the rest stay alive hidden. The tab × unmounts → kills that PTY. */}
      {terminals.length > 0 && (
        <div className="terminal-drawer" style={{ display: terminalOpen ? 'flex' : 'none' }}>
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
                    ×
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
                +
              </button>
            </div>
            <button
              className="terminal-close"
              type="button"
              onClick={() => setTerminalOpen(false)}
              title="Hide terminal (Ctrl+`) — keeps it running"
              aria-label="Hide terminal"
            >
              ▾
            </button>
          </div>
          <div className="terminal-body">
            {terminals.map((id) => (
              <div
                key={id}
                className="terminal-tabpane"
                style={{ display: id === activeTerm ? 'flex' : 'none' }}
              >
                <TerminalPane theme={theme} onAttention={() => markTermAttention(id)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    </>
  );
}
