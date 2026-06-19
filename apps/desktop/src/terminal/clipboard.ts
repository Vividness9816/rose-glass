/* Pure clipboard-key decisions for the terminal, isolated from xterm + the IPC so the
   SIGINT-correctness branch is unit-tested, not discovered by hand-running a hung
   process. The one rule that must never break: a bare Ctrl+C with NO live selection is
   the interrupt — it has to reach the PTY as \x03, never be swallowed by a copy binding. */

export type ClipboardAction = 'copy' | 'paste' | 'passthrough';

/** Right-click = conhost QuickEdit: copy when there's a selection, otherwise paste. */
export function decideContextMenu(hasSelection: boolean): ClipboardAction {
  return hasSelection ? 'copy' : 'paste';
}

/** Keyboard decision. 'passthrough' means: let xterm send the bytes to the PTY (so bare
    Ctrl+C without a selection stays SIGINT). Only fires on keydown + Ctrl held. */
export function decideKey(
  e: { key: string; ctrlKey: boolean; shiftKey: boolean; type: string },
  hasSelection: boolean,
): ClipboardAction {
  if (e.type !== 'keydown' || !e.ctrlKey) return 'passthrough';
  const k = e.key.toLowerCase();
  // Ctrl+Shift+C / Ctrl+Shift+V — unambiguous copy / paste.
  if (e.shiftKey && k === 'c') return 'copy';
  if (e.shiftKey && k === 'v') return 'paste';
  if (e.shiftKey) return 'passthrough';
  // Ctrl+V — paste.
  if (k === 'v') return 'paste';
  // Ctrl+C — copy ONLY with a live selection; otherwise it is the interrupt → passthrough.
  if (k === 'c') return hasSelection ? 'copy' : 'passthrough';
  return 'passthrough';
}

/** Strip a single trailing newline so a pasted command isn't auto-submitted. Defence in
    depth: PowerShell/pwsh enable bracketed paste (DECSET 2004) which already neutralises
    auto-run, but cmd.exe and other shells do not — this is the shell-agnostic floor. */
export function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}
