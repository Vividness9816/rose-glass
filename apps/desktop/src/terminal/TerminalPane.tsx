/* Embedded terminal (xterm.js ↔ portable-pty via IPC). The PTY lives in Rust; this
   pane renders xterm, streams keystrokes out (onData → pty_write) and bytes in
   (pty:output → term.write), and resizes the PTY to fit. cwd defaults to the open
   vault server-side (backend reads AppState.vault_root), so we pass cwd=null.
   Colors/font are read from the token layer (no hardcoded values — A10/§16). */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Theme } from '../appearance/theme';
import {
  inTauri,
  onPtyExit,
  onPtyOutput,
  ptyAttach,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from '../ipc';
import { decideContextMenu, decideKey, stripTrailingNewline } from './clipboard';
import './terminal.css';

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm theme from the token layer (re-read on theme flip so the terminal re-themes live). */
function xtermTheme() {
  return {
    background: token('--surface-1'),
    foreground: token('--text-1'),
    cursor: token('--rose'),
    cursorAccent: token('--bg'),
    selectionBackground: token('--rose-glow'),
  };
}

export function TerminalPane({ theme, onAttention }: { theme: Theme; onAttention?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [copied, setCopied] = useState(false); // brief "copied" flash (copy is otherwise invisible)
  // Latest callback without re-running the (mount-once) PTY effect.
  const onAttentionRef = useRef(onAttention);
  onAttentionRef.current = onAttention;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !inTauri()) return; // PTY needs the Rust backend; web build shows the placeholder

    const term = new Terminal({
      fontFamily: token('--font-mono') || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: xtermTheme(),
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // Attention heuristic: a child (e.g. Claude Code awaiting input) rings the terminal
    // bell (BEL / \x07). xterm surfaces that as onBell — the Shell flags the tab green if
    // it isn't the active one. ponytail: bell is the one concrete signal; a fuller "is the
    // prompt waiting" heuristic would have to parse PTY output for shell-specific prompts.
    term.onBell(() => onAttentionRef.current?.());

    let id = -1;
    let unOut: UnlistenFn | undefined;
    let unExit: UnlistenFn | undefined;
    let disposed = false;
    let settleTimer: number | undefined;

    // Never write to a disposed terminal (an output chunk can land mid-teardown).
    const writeSafe = (data: string | Uint8Array) => {
      if (disposed) return;
      try {
        term.write(data);
      } catch {
        /* terminal torn down */
      }
    };

    // Attention (v2.1): write the chunk, then (re)arm a settle timer. When output stops for
    // ~400ms the command has likely finished / is waiting → signal the Shell, which flags
    // the tab ONLY if it's unattended. A continuous stream keeps re-arming and never
    // settles, so a long build won't scream; it flags once, when it goes quiet.
    const onOutput = (data: string | Uint8Array) => {
      writeSafe(data);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => onAttentionRef.current?.(), 400);
    };

    void (async () => {
      try {
        id = await ptySpawn(null, term.cols, term.rows); // cwd=null → backend uses the vault root
        // Re-check `disposed` after every await: if teardown ran while suspended, undo
        // it here (the synchronous cleanup can't see listeners assigned post-await).
        if (disposed) {
          void ptyKill(id);
          return;
        }
        unOut = await onPtyOutput(id, onOutput);
        if (disposed) {
          unOut();
          return;
        }
        unExit = await onPtyExit(id, () => {
          id = -1; // shell exited → stop routing keystrokes to the dead pty
          writeSafe('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
        });
        if (disposed) {
          unExit();
          return;
        }
        // v2.0: listeners are wired — drain the bytes the reader buffered pre-attach (the
        // shell's first prompt/banner) and switch to live emit. Closes the first-prompt race.
        await ptyAttach(id);
        term.onData((d) => {
          if (id >= 0 && !disposed) void ptyWrite(id, d);
        });
      } catch (e) {
        writeSafe(`\r\n\x1b[31mfailed to start terminal: ${String(e)}\x1b[0m\r\n`);
      }
    })();

    // ── Clipboard shortcuts (PowerShell-style). Right-click = copy-if-selection-else-paste;
    // Ctrl+C copies ONLY with a live selection (else it passes through as \x03 SIGINT);
    // Ctrl+V / Ctrl+Shift+C / Ctrl+Shift+V. The copy/SIGINT branching is unit-tested in
    // clipboard.ts; here we only do the IO. Paste routes through term.paste so PowerShell's
    // bracketed paste wraps it (no auto-run) and a trailing newline is stripped as a floor.
    const flashCopied = () => {
      if (disposed) return;
      setCopied(true);
      window.setTimeout(() => {
        if (!disposed) setCopied(false);
      }, 900);
    };
    const doCopy = () => {
      const sel = term.getSelection();
      if (!sel) return;
      void (async () => {
        try {
          const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
          await writeText(sel);
          term.clearSelection(); // so a following bare Ctrl+C is the interrupt again
          flashCopied();
        } catch (e) {
          console.debug('terminal copy failed:', e);
        }
      })();
    };
    const doPaste = () => {
      void (async () => {
        try {
          const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
          const text = await readText();
          if (text) term.paste(stripTrailingNewline(text));
        } catch (e) {
          console.debug('terminal paste failed:', e);
        }
      })();
    };
    term.attachCustomKeyEventHandler((e) => {
      const action = decideKey(e, term.hasSelection());
      if (action === 'copy') {
        e.preventDefault();
        doCopy();
        return false;
      }
      if (action === 'paste') {
        e.preventDefault();
        doPaste();
        return false;
      }
      return true; // passthrough: xterm sends the bytes (bare Ctrl+C → \x03 SIGINT)
    });
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (decideContextMenu(term.hasSelection()) === 'copy') doCopy();
      else doPaste();
    };
    host.addEventListener('contextmenu', onContextMenu);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (id >= 0) void ptyResize(id, term.cols, term.rows);
      } catch {
        /* host detached mid-resize */
      }
    });
    ro.observe(host);
    term.focus();

    return () => {
      disposed = true;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      ro.disconnect();
      host.removeEventListener('contextmenu', onContextMenu);
      unOut?.();
      unExit?.();
      if (id >= 0) void ptyKill(id);
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Live re-theme without tearing down the PTY session.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme();
  }, [theme]);

  if (!inTauri()) {
    return <div className="terminal-host terminal-placeholder">Terminal runs in the desktop app.</div>;
  }
  return (
    <div className="terminal-host-wrap">
      <div className="terminal-host" ref={hostRef} />
      <span className={`terminal-copied${copied ? ' show' : ''}`} aria-hidden="true">
        copied
      </span>
    </div>
  );
}
