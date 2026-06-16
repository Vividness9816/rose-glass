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

export const readNoteFile = (path: string) => invoke<string>('read_note_file', { path });
export const saveNoteFile = (path: string, content: string) =>
  invoke<void>('save_note_file', { path, content });
export const resolveLink = (target: string, srcPath: string) =>
  invoke<string | null>('resolve_link', { target, srcPath });

export const onIndexNote = (
  cb: (e: { path: string; op: 'upsert' | 'delete' }) => void,
): Promise<UnlistenFn> =>
  listen<{ path: string; op: 'upsert' | 'delete' }>('index:note', (e) => cb(e.payload));

export const onIndexRebuilt = (cb: (e: { note_count: number }) => void): Promise<UnlistenFn> =>
  listen<{ note_count: number }>('index:rebuilt', (e) => cb(e.payload));

/** True when running inside the Tauri shell (vs plain Vite / Playwright). */
export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
