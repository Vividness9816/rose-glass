//! Embedded terminal: portable-pty (ConPTY on Windows) ↔ xterm.js via Tauri events.
//!
//! pty_spawn opens a PTY + shell (cwd = explicit, else the open vault root), spawns a
//! reader thread that emits `pty:output` { id, data: bytes } per chunk and `pty:exit`
//! { id } at EOF, and keeps the writer/master/killer in a registry keyed by id.
//! The frontend wires xterm: keystrokes → pty_write, bytes → term.write, fit → pty_resize.

use crate::state::{lock, AppState};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// One live PTY session: the master (for resize), the writer (for keystrokes; behind
/// its own Arc<Mutex> so a blocking write never holds the registry lock — the killer
/// stays reachable for a hung child), and a killer (to terminate the child on close).
/// The reader half is owned by the reader thread.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// v2.0: bytes the reader produced before the UI attached its listener (a capped ring).
    /// `pty_attach` drains it + switches to live emit — fixes the first-prompt race.
    buffer: Arc<Mutex<PtyBuffer>>,
}

/// Pre-attach output buffer. Until the UI calls `pty_attach`, the reader appends here
/// (keeping the most-recent `RING_CAP` bytes); after attach (or a 5s TTL fallback) the
/// reader emits live. Emits are done while HOLDING this lock so the flushed buffer can
/// never arrive after a later live chunk (strict ordering).
#[derive(Default)]
struct PtyBuffer {
    pending: Vec<u8>,
    attached: bool,
}

/// Pre-attach ring cap: a prompt + banner fits easily; we only need what's on screen
/// before the listener wires up, not full scrollback.
const RING_CAP: usize = 4096;

/// If the UI never attaches (crash / abandoned spawn), stop buffering after this and emit
/// live so output isn't held hostage (events with no listener drop harmlessly).
const ATTACH_TTL: Duration = Duration::from_secs(5);

/// Append `chunk`, keeping only the most-recent `cap` bytes. Pure → unit-tested.
fn push_capped(buf: &mut Vec<u8>, chunk: &[u8], cap: usize) {
    buf.extend_from_slice(chunk);
    if buf.len() > cap {
        let excess = buf.len() - cap;
        buf.drain(..excess);
    }
}

#[derive(Default)]
pub struct TerminalRegistry {
    // Arc so the reader thread can hold a handle and evict the session on child exit.
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next_id: AtomicU32,
}

#[derive(Serialize, Clone)]
struct OutputEvent {
    id: u32,
    data: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: u32,
}

/// cwd resolution: explicit path wins, else the open vault root, else None (shell default).
/// Pure so it's unit-testable without a PTY.
fn resolve_cwd(explicit: Option<String>, vault_root: Option<PathBuf>) -> Option<String> {
    explicit.or_else(|| vault_root.map(|p| p.to_string_lossy().into_owned()))
}

fn shell_command() -> CommandBuilder {
    if cfg!(windows) {
        CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()))
    } else {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    app_state: State<'_, AppState>,
    reg: State<'_, TerminalRegistry>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let sys = native_pty_system();
    let pair = sys
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = shell_command();
    let vault_root = lock(&app_state.vault_root).clone();
    if let Some(dir) = resolve_cwd(cwd, vault_root) {
        cmd.cwd(dir);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave); // let the master see EOF when the child exits
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

    let id = reg.next_id.fetch_add(1, Ordering::Relaxed);
    let sessions = Arc::clone(&reg.sessions); // reader thread evicts the session on exit

    // Reader thread: BUFFER raw bytes until the UI attaches (fixes the first-prompt race),
    // then stream live. Binary-safe (Vec<u8>) so escape sequences / multibyte UTF-8 split
    // across reads stay intact. Every emit happens under the buffer lock so the flushed
    // pre-attach buffer can never land after a later live chunk.
    let app2 = app.clone();
    let buffer = Arc::new(Mutex::new(PtyBuffer::default()));
    let reader_buf = Arc::clone(&buffer);
    let spawned = Instant::now();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut b = lock(&reader_buf);
                    if b.attached {
                        let _ = app2.emit("pty:output", OutputEvent { id, data: buf[..n].to_vec() });
                    } else if spawned.elapsed() > ATTACH_TTL {
                        // TTL fallback: flush what we have + this chunk, then go live.
                        b.attached = true;
                        let mut drained = std::mem::take(&mut b.pending);
                        drained.extend_from_slice(&buf[..n]);
                        let _ = app2.emit("pty:output", OutputEvent { id, data: drained });
                    } else {
                        push_capped(&mut b.pending, &buf[..n], RING_CAP);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        lock(&sessions).remove(&id); // evict dead session (handles, killer) — don't wait for drawer close
        let _ = app2.emit("pty:exit", ExitEvent { id });
    });

    lock(&reg.sessions).insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
            buffer,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn pty_write(reg: State<'_, TerminalRegistry>, id: u32, data: String) -> Result<(), String> {
    // Clone the writer handle out under a brief registry lock, then write WITHOUT holding
    // it — a child that stops draining stdin can't wedge pty_kill/pty_resize this way.
    let writer = {
        let sessions = lock(&reg.sessions);
        Arc::clone(&sessions.get(&id).ok_or("no such terminal")?.writer)
    };
    let mut w = lock(&writer);
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    reg: State<'_, TerminalRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = lock(&reg.sessions);
    let s = sessions.get(&id).ok_or("no such terminal")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(reg: State<'_, TerminalRegistry>, id: u32) -> Result<(), String> {
    if let Some(mut s) = lock(&reg.sessions).remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

/// v2.0: the UI calls this AFTER wiring its `pty:output` listener. Flushes the bytes the
/// reader buffered before the listener existed (as one ordered `pty:output` event) and
/// switches the session to live emit — closing the first-prompt race. The flush runs under
/// the buffer lock so it precedes any later live chunk. Idempotent / no-op if already live.
#[tauri::command]
pub fn pty_attach(app: AppHandle, reg: State<'_, TerminalRegistry>, id: u32) -> Result<(), String> {
    let buffer = {
        let sessions = lock(&reg.sessions);
        Arc::clone(&sessions.get(&id).ok_or("no such terminal")?.buffer)
    };
    let mut b = lock(&buffer);
    if b.attached {
        return Ok(()); // already live (e.g. the TTL fired first) — nothing buffered to flush
    }
    let pending = std::mem::take(&mut b.pending);
    b.attached = true;
    if !pending.is_empty() {
        let _ = app.emit("pty:output", OutputEvent { id, data: pending });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn ring_buffer_keeps_most_recent_bytes() {
        let mut b = Vec::new();
        push_capped(&mut b, b"hello", 4);
        assert_eq!(b, b"ello", "over cap → keep the last 4");
        push_capped(&mut b, b"XY", 4);
        assert_eq!(b, b"loXY", "still the last 4 across calls");
        let mut c = Vec::new();
        push_capped(&mut c, b"ab", 8);
        assert_eq!(c, b"ab", "under cap → untouched");
        push_capped(&mut c, b"cdef", 8);
        assert_eq!(c, b"abcdef", "exactly at/under cap → kept whole");
    }

    #[test]
    fn resolve_cwd_prefers_explicit_then_vault() {
        assert_eq!(
            resolve_cwd(Some("X".into()), Some(PathBuf::from("Y"))),
            Some("X".into())
        );
        assert_eq!(
            resolve_cwd(None, Some(PathBuf::from("Y"))),
            Some("Y".into())
        );
        assert_eq!(resolve_cwd(None, None), None);
    }

    /// SPIKE: portable-pty must spawn a real shell (ConPTY on Windows) and let us read
    /// its output. Read on a worker thread and stop at the marker — Windows ConPTY does
    /// NOT reliably deliver EOF for a one-shot child, so a recv_timeout bounds the test:
    /// it FAILS fast if no output arrives, and can never hang the build.
    #[test]
    fn pty_echo_round_trip() {
        use std::sync::mpsc;
        use std::time::Duration;

        let sys = native_pty_system();
        let pair = sys
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = shell_command();
        if cfg!(windows) {
            cmd.arg("/C");
        } else {
            cmd.arg("-c");
        }
        cmd.arg("echo rose_pty_ok_12345");

        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut killer = child.clone_killer();

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut out = String::new();
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        out.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if out.contains("rose_pty_ok_12345") {
                            break; // got it — don't block waiting for an EOF that won't come
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(out);
        });

        let out = rx.recv_timeout(Duration::from_secs(15));
        let _ = killer.kill();
        let _ = child.wait();
        let out = out.expect("pty produced no marker output within 15s");

        assert!(out.contains("rose_pty_ok_12345"), "pty output was: {out:?}");
    }
}
