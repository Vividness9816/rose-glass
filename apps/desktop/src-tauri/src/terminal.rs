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
use tauri::{AppHandle, Emitter, State};

/// One live PTY session: the master (for resize), the writer (for keystrokes; behind
/// its own Arc<Mutex> so a blocking write never holds the registry lock — the killer
/// stays reachable for a hung child), and a killer (to terminate the child on close).
/// The reader half is owned by the reader thread.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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

    // Reader thread: stream raw bytes to the UI, then signal exit. Binary-safe (Vec<u8>)
    // so escape sequences / multibyte UTF-8 split across reads stay intact.
    // ponytail: a small race exists between spawn returning and the UI attaching its
    // listener; the first prompt bytes can be missed. Press Enter for a fresh prompt.
    // Upgrade: buffer-until-attached if it bites.
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app2.emit(
                        "pty:output",
                        OutputEvent {
                            id,
                            data: buf[..n].to_vec(),
                        },
                    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

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
