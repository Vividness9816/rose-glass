// The ONLY module that imports @tauri-apps/api. Components/hooks call these typed
// wrappers; they mirror the Rust IPC commands (src-tauri/src/commands.rs).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface LinkDto {
  dst_path: string | null;
  dst_raw: string;
  link_type: 'wikilink' | 'markdown' | 'embed';
}
export interface NoteDto {
  path: string;
  title: string;
  frontmatter: unknown | null;
  word_count: number;
  mtime: number;
  indexed_at: number;
  tags: string[];
  out_links: LinkDto[];
}
export interface BacklinkDto {
  src_path: string;
  src_title: string;
  link_type: string;
}
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  rank: number;
}
export interface TagCount {
  tag: string;
  count: number;
}
export interface SemanticHit {
  path: string;
  title: string;
  /** cosine similarity to the query, −1..1 (1 = identical direction). */
  score: number;
}
export interface SemanticResult {
  /** false ⇒ no embeddings computed yet (recompute clusters to enable). */
  ready: boolean;
  /** true ⇒ some notes are unembedded since the last recompute; hits rank a partial corpus. */
  stale: boolean;
  hits: SemanticHit[];
}
export interface OpenVaultResult {
  vault: string;
  note_count: number;
  rebuilt: boolean;
}
export interface GraphNodeMeta {
  path: string;
  title: string;
  cluster: number | null;
  link_count: number;
}
export interface GraphEdgeMeta {
  src: string;
  dst: string;
}
export interface GraphPayload {
  nodes: GraphNodeMeta[];
  edges: GraphEdgeMeta[];
}

export const openVault = (path: string) => invoke<OpenVaultResult>('open_vault', { path });
export const getNote = (path: string) => invoke<NoteDto | null>('get_note', { path });
export const getBacklinks = (path: string) => invoke<BacklinkDto[]>('get_backlinks', { path });
export const search = (query: string) => invoke<SearchHit[]>('search', { query });
export const getTags = () => invoke<TagCount[]>('get_tags');
export const getGraphPayload = () => invoke<GraphPayload>('get_graph_payload');
export const reindex = () => invoke<OpenVaultResult>('reindex');
/** Embed every note (local ONNX) + k-means into the clusters table; returns the cluster count.
 *  Slow on first run (downloads the model). Emits index:rebuilt so the graph recolours. */
export const recomputeClusters = () => invoke<number>('recompute_clusters');

/** On-disk byte size of a vault file (Properties popover). Vault-relative + safe_join-guarded. */
export const fileSize = (path: string) => invoke<number>('file_size', { path });

/** Phase 13 (ADR-20260618): notes most similar to `path` by cosine over the stored
 *  embeddings. MODEL-FREE (the note's vector is already stored) — fast, no ONNX. Excludes
 *  the note itself. `ready=false` until clusters/embeddings are computed once. */
export const relatedNotes = (path: string, k: number) =>
  invoke<SemanticResult>('related_notes', { path, k });

/** Phase 13: free-text semantic search — embeds `query` (local ONNX, loaded per call) and
 *  ranks the stored embeddings by cosine. Submit-based, not as-you-type (the model load is
 *  slow; cache it in AppState before wiring debounced search). */
export const semanticSearch = (query: string, k: number) =>
  invoke<SemanticResult>('semantic_search', { query, k });

export const readNoteFile = (path: string) => invoke<string>('read_note_file', { path });
export const saveNoteFile = (path: string, content: string) =>
  invoke<void>('save_note_file', { path, content });
export const resolveLink = (target: string, srcPath: string) =>
  invoke<string | null>('resolve_link', { target, srcPath });

/** Phase 9: read a vault file as raw bytes (PDF/docx view). The Rust command returns a
 *  `tauri::ipc::Response`, so `invoke` resolves to an ArrayBuffer (efficient — not a
 *  number[]). Same vault-root guard as the text path: binaries must be inside the vault. */
export const readFileBytes = async (path: string): Promise<Uint8Array> => {
  const buf = await invoke<ArrayBuffer>('read_file_bytes', { path });
  return new Uint8Array(buf);
};

export const onIndexNote = (
  cb: (e: { path: string; op: 'upsert' | 'delete' }) => void,
): Promise<UnlistenFn> =>
  listen<{ path: string; op: 'upsert' | 'delete' }>('index:note', (e) => cb(e.payload));

export const onIndexRebuilt = (cb: (e: { note_count: number }) => void): Promise<UnlistenFn> =>
  listen<{ note_count: number }>('index:rebuilt', (e) => cb(e.payload));

// ── Activity (Phase 8) — mirrors src-tauri/src/activity.rs (M1 transcript-tail) ──
// A scoped CC activity event. The `external` variant carries NO path BY CONSTRUCTION
// (the Rust enum has no field) — an out-of-vault path never crosses this boundary.
export type ActivityEvent =
  | { scope: 'vault'; action: 'read' | 'modify'; rel: string; tool: string; session: string }
  | { scope: 'external'; action: 'read' | 'modify'; tool: string; session: string };

/** Start the read-only CC activity tail. `generation` (a monotonic token bumped per
 *  effect run) serializes start↔stop against StrictMode / rapid view-toggle. */
export const activityStart = (generation: number) =>
  invoke<void>('activity_start', { generation });
/** Stop the activity tail (drops the watcher; in-memory only — nothing persisted). */
export const activityStop = (generation: number) =>
  invoke<void>('activity_stop', { generation });

/** M2 hook (ADR-20260617). plan = read-only dry-run; arm/disarm WRITE ~/.claude/settings.json
 *  (backup + atomic + re-validate-all-hooks) and are gated behind an explicit UI confirm. */
export const activityHookPlan = () => invoke<string>('activity_hook_plan');
export const activityHookArm = () => invoke<string>('activity_hook_arm');
export const activityHookDisarm = () => invoke<string>('activity_hook_disarm');

export const onActivityEvent = (cb: (e: ActivityEvent) => void): Promise<UnlistenFn> =>
  listen<ActivityEvent>('activity:event', (e) => cb(e.payload));
/** Cumulative count of events dropped by the backend per-tick overflow cap. */
export const onActivityDropped = (cb: (dropped: number) => void): Promise<UnlistenFn> =>
  listen<{ dropped: number }>('activity:dropped', (e) => cb(e.payload.dropped));
/** Cumulative count of malformed/unparsable transcript lines — the schema-drift
 *  health signal (nonzero ⇒ a torn-line bug or a CC transcript-format change). */
export const onActivityAnomaly = (cb: (anomalies: number) => void): Promise<UnlistenFn> =>
  listen<{ anomalies: number }>('activity:anomaly', (e) => cb(e.payload.anomalies));

// ── Terminal (PTY) — mirrors src-tauri/src/terminal.rs ──
// Output is raw bytes (Vec<u8> → number[]) so escape sequences / non-ASCII survive
// chunk boundaries intact; xterm.write() takes a Uint8Array.
export const ptySpawn = (cwd: string | null, cols: number, rows: number) =>
  invoke<number>('pty_spawn', { cwd, cols, rows });
export const ptyWrite = (id: number, data: string) => invoke<void>('pty_write', { id, data });
export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>('pty_resize', { id, cols, rows });
export const ptyKill = (id: number) => invoke<void>('pty_kill', { id });

export const onPtyOutput = (id: number, cb: (data: Uint8Array) => void): Promise<UnlistenFn> =>
  listen<{ id: number; data: number[] }>('pty:output', (e) => {
    if (e.payload.id === id) cb(new Uint8Array(e.payload.data));
  });
export const onPtyExit = (id: number, cb: () => void): Promise<UnlistenFn> =>
  listen<{ id: number }>('pty:exit', (e) => {
    if (e.payload.id === id) cb();
  });

/** True when running inside the Tauri shell (vs plain Vite / Playwright). */
export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
