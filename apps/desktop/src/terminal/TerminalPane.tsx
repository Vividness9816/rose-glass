/* Embedded terminal (xterm.js ↔ portable-pty via IPC). The PTY lives in Rust; this
   pane renders xterm, streams keystrokes out (onData → pty_write) and bytes in
   (pty:output → term.write), and resizes the PTY to fit. cwd defaults to the open
   vault server-side (backend reads AppState.vault_root), so we pass cwd=null.
   Colors/font are read from the token layer (no hardcoded values — A10/§16). */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { Theme } from '../appearance/theme';
import {
  inTauri,
  onPtyExit,
  onPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from '../ipc';
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

export function TerminalPane({ theme }: { theme: Theme }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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

    let id = -1;
    let unOut: UnlistenFn | undefined;
    let unExit: UnlistenFn | undefined;
    let disposed = false;

    // Never write to a disposed terminal (an output chunk can land mid-teardown).
    const writeSafe = (data: string | Uint8Array) => {
      if (disposed) return;
      try {
        term.write(data);
      } catch {
        /* terminal torn down */
      }
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
        unOut = await onPtyOutput(id, writeSafe);
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
        term.onData((d) => {
          if (id >= 0 && !disposed) void ptyWrite(id, d);
        });
      } catch (e) {
        writeSafe(`\r\n\x1b[31mfailed to start terminal: ${String(e)}\x1b[0m\r\n`);
      }
    })();

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
      ro.disconnect();
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
  return <div className="terminal-host" ref={hostRef} />;
}
