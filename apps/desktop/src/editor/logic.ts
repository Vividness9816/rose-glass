/* Pure editor logic — no CodeMirror / DOM / IPC imports, fully unit-testable. */

/** Strip `|alias` then `#heading` from a wikilink inner; trim. Mirrors the
 *  Rust parser's split_wikilink_inner. */
export function extractWikiTarget(inner: string): string {
  const beforeAlias = inner.split('|')[0] ?? inner;
  const beforeHeading = beforeAlias.split('#')[0] ?? beforeAlias;
  return beforeHeading.trim();
}

export interface ReloadInput {
  eventPath: string;
  openPath: string | null;
  isDirty: boolean;
  lastSavedContent: string | null;
  diskContent: string;
}

/** Whether to replace the editor buffer from disk on an index event.
 *  Never stomp the path the user is editing, never stomp unsaved edits,
 *  never reload our own save echo. */
export function shouldReloadDoc(i: ReloadInput): boolean {
  if (i.openPath == null || i.eventPath !== i.openPath) return false;
  if (i.isDirty) return false;
  if (i.lastSavedContent !== null && i.diskContent === i.lastSavedContent) return false;
  return true;
}

/** Alphabetically-first note path (deterministic auto-open target). */
export function firstNotePath(nodes: { path: string }[]): string | undefined {
  return nodes.map((n) => n.path).sort()[0];
}

export interface DebouncedSaver {
  schedule(path: string, content: string): void;
  flush(): void;
}

/** Debounced autosave that coalesces rapid edits to one write, and can be
 *  flushed immediately (e.g. before switching notes — so edits aren't dropped). */
export function makeDebouncedSaver(
  save: (path: string, content: string) => void,
  delayMs: number,
): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { path: string; content: string } | null = null;

  const fire = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      const p = pending;
      pending = null;
      save(p.path, p.content);
    }
  };

  return {
    schedule(path, content) {
      pending = { path, content };
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    flush: fire,
  };
}
