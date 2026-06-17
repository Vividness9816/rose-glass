/* Phase 9 — pure helpers for opening a non-markdown file (PDF/docx) from disk.
   The Open-file dialog hands back an ABSOLUTE path, but the IPC contract (and
   `fs_safe::safe_join`) is vault-relative + rejects `..`/absolute — so a binary must
   live inside the vault. These functions are the UI-side gate; the Rust `safe_join`
   re-validates and is the real boundary. Pure → unit-testable. */

/** Convert an absolute path to a vault-relative forward-slash path, or null if it is
 *  not strictly inside the vault root. Comparison is case-insensitive (Windows FS).
 *  The relative portion preserves the original case so it matches the file on disk. */
export function toVaultRelative(abs: string, root: string): string | null {
  const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = slash(abs);
  const r = slash(root);
  if (r === '') return null;
  const al = a.toLowerCase();
  const rl = r.toLowerCase();
  if (al === rl) return null; // the root itself is not a file
  if (!al.startsWith(rl + '/')) return null; // outside the vault (the '/' blocks sibling-prefix tricks)
  return a.slice(r.length + 1);
}

/** Sibling Markdown path for a docx "edit as markdown" extraction: `report.docx` →
 *  `report.docx.md` (the `.docx.` keeps it distinct from a hand-authored `report.md`). */
export function siblingMdPath(path: string): string {
  return `${path}.md`;
}
