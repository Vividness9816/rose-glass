//! Phase 8 — read-only Claude Code activity mirror (M1 transcript-tail). ADR-20260617.
//!
//! Tails `~/.claude/projects/**/*.jsonl` (the transcripts CC writes for every
//! session) and turns each file-touching `tool_use` line into an `ActivityEvent`
//! that the graph (node light-up) and the Activity pane consume. Read-only; no
//! `settings.json` mutation (the global-hook path stays deferred per ADR-20260617).
//!
//! REDACTION IS STRUCTURAL AND APPLIED AT THIS SOURCE: the `External` variant has
//! no `rel`/path field, so an out-of-vault file path never crosses the IPC boundary
//! into the UI process. This is stronger than a render-time strip — a blocklist
//! leaks the day a new field is added; a type that *cannot hold* the value can't.
//!
//! Classification is purely lexical (no filesystem access): a path that escapes the
//! vault via `..` fails closed to `External`, so an escape cannot masquerade as a
//! vault node. ponytail: symlink-escape (a symlink inside the vault pointing out) is
//! not resolved — only the vault-relative key would ever render, never the real
//! target; upgrade with `std::fs::canonicalize` if that ever matters.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::RecursiveMode;
use std::any::Any;
use tauri::{AppHandle, Emitter};

use crate::state::lock;

/// Cap on events surfaced per debounce tick — a tool-call storm (e.g. a parallel
/// Workflow fan-out) must not flood the UI. Overflow is counted, not silently lost.
/// ponytail: O(lines-per-tick) cap; raise if a busy machine clips real activity.
const MAX_EVENTS_PER_TICK: usize = 64;

/// Defensive cap on the per-file partial-line buffer: CC writes newline-delimited
/// JSONL, so a buffer growing past this without a newline is pathological — resync
/// past it rather than grow unbounded. ponytail: a guard, not a normal-path concern.
const MAX_PARTIAL_BYTES: usize = 1 << 20; // 1 MiB

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Read,   // → violet pulse
    Modify, // → rose flare
}

/// A scoped, ephemeral activity event (spec §19.9 — never persisted). `Vault`
/// carries the vault-relative node key (forward-slash, matches the indexer); the
/// `External` variant carries NO path by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "scope", rename_all = "lowercase")]
pub enum ActivityEvent {
    Vault {
        action: Action,
        rel: String,
        tool: String,
        session: String,
    },
    External {
        action: Action,
        tool: String,
        session: String,
    },
}

/// Lexically normalize a path string into ORIGINAL-case components — collapsing
/// `.`/`..` WITHOUT touching the filesystem. Returns `None` if `..` escapes above
/// the root, so an escape can't be mistaken for in-vault. Case-folding for the
/// in-vault *comparison* happens in `classify_scope` (the emitted node key must keep
/// the file's real case to match the indexer's `normalize_rel`).
fn norm_components(p: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in p.split(['/', '\\']) {
        match raw {
            "" | "." => continue,
            ".." => {
                out.pop()?; // escape above root → None (fail closed)
            }
            seg => out.push(seg.to_string()),
        }
    }
    Some(out)
}

/// Case-fold copies for comparison only (Windows paths are case-insensitive).
fn folded(v: &[String]) -> Vec<String> {
    if cfg!(windows) {
        v.iter().map(|s| s.to_ascii_lowercase()).collect()
    } else {
        v.to_vec()
    }
}

enum Scope {
    Vault(String),
    External,
}

/// Classify a file path against the vault root. `Vault(rel)` only if the normalized
/// file path is strictly *under* the normalized vault root; everything else is
/// `External` (fail closed). Pure — no filesystem access. The prefix check is
/// case-folded (Windows); the returned `rel` preserves the file's real case so it
/// matches the graph node key.
fn classify_scope(file_path: &str, vault_root: &str) -> Scope {
    let (Some(fp), Some(root)) = (norm_components(file_path), norm_components(vault_root)) else {
        return Scope::External;
    };
    let (fp_f, root_f) = (folded(&fp), folded(&root));
    if root_f.is_empty() || fp_f.len() <= root_f.len() || !fp_f.starts_with(root_f.as_slice()) {
        return Scope::External;
    }
    // The strict-length guard above guarantees >=1 trailing component, so rel is
    // never empty here. The emitted rel keeps CC's REPORTED case (for the pane);
    // node matching is case-folded on the frontend (a case-insensitive FS can report
    // a different in-vault casing than the on-disk index key).
    Scope::Vault(fp[root.len()..].join("/"))
}

/// Decide whether `activity_start(gen)` should spawn: spawn unless a watcher already
/// exists at a generation >= gen (a newer/equal start already owns the tail). Pure —
/// the serialization point for the StrictMode/rapid-toggle start↔stop race.
pub fn should_start(stored_gen: u64, has_watcher: bool, gen: u64) -> bool {
    !(has_watcher && stored_gen >= gen)
}

/// Decide whether `activity_stop(gen)` should clear the watcher: only if no NEWER
/// start has taken over (stored_gen <= gen) — a stale stop must not drop a newer
/// start's watcher (the leak the review found). Pure.
pub fn should_stop(stored_gen: u64, gen: u64) -> bool {
    stored_gen <= gen
}

fn short_session(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Result of classifying one transcript line.
pub struct Classified {
    pub events: Vec<ActivityEvent>,
    /// A non-empty line that FAILED to parse as JSON — the schema-drift / torn-line
    /// health signal. With correct buffering, complete lines are always valid JSON,
    /// so a nonzero cumulative count means CC's format changed or a line was torn.
    pub anomaly: bool,
}

/// Parse one transcript JSONL line into zero or more activity events (a single
/// assistant message can carry parallel tool calls). Pure. Non-assistant or
/// non-file-touching lines yield no events; a malformed complete line is flagged as
/// an `anomaly` (drift signal), not silently swallowed.
pub fn classify_line(line: &str, vault_root: &str) -> Classified {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Classified { events: Vec::new(), anomaly: false };
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return Classified { events: Vec::new(), anomaly: true };
    };
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return Classified { events: Vec::new(), anomaly: false };
    }
    let session = v
        .get("sessionId")
        .and_then(|s| s.as_str())
        .map(short_session)
        .unwrap_or_default();
    let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array())
    else {
        return Classified { events: Vec::new(), anomaly: false };
    };
    let mut events = Vec::new();
    for c in content {
        if c.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let Some(name) = c.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        let action = match name {
            "Read" => Action::Read,
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Action::Modify,
            _ => continue,
        };
        let Some(fp) = c
            .get("input")
            .and_then(|i| i.get("file_path"))
            .and_then(|p| p.as_str())
        else {
            continue;
        };
        events.push(match classify_scope(fp, vault_root) {
            Scope::Vault(rel) => ActivityEvent::Vault {
                action,
                rel,
                tool: name.to_string(),
                session: session.clone(),
            },
            Scope::External => ActivityEvent::External {
                action,
                tool: name.to_string(),
                session: session.clone(),
            },
        });
    }
    Classified { events, anomaly: false }
}

/// Incremental, rotation-safe transcript reader. Tracks a byte offset and buffers a
/// torn final line (raw bytes — never splits a multibyte char across reads) until
/// its newline arrives.
#[derive(Default)]
pub struct Tailer {
    offset: u64,
    partial: Vec<u8>,
}

impl Tailer {
    /// Start at the file's current end so only NEW activity streams (no history
    /// replay). A fresh file / missing file starts at 0.
    pub fn at_end(path: &Path) -> Self {
        let offset = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        Tailer {
            offset,
            partial: Vec::new(),
        }
    }

    /// Read bytes appended since the last call; return complete lines, buffering any
    /// torn trailing line. Detects truncation/rotation (`len < offset`) and resyncs
    /// from the start.
    pub fn read_new_lines(&mut self, path: &Path) -> std::io::Result<Vec<String>> {
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        if len < self.offset {
            self.offset = 0; // rotated/truncated → resync
            self.partial.clear();
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::new();
        let n = f.take(len - self.offset).read_to_end(&mut buf)?;
        self.offset += n as u64;
        self.partial.extend_from_slice(&buf);
        // Defensive: a pathological newline-less line must not grow `partial` without
        // bound — resync past it (CC writes newline-delimited JSONL).
        if self.partial.len() > MAX_PARTIAL_BYTES && !self.partial.contains(&b'\n') {
            self.partial.clear();
        }

        let mut lines = Vec::new();
        while let Some(idx) = self.partial.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.partial.drain(..=idx).collect();
            let s = String::from_utf8_lossy(&raw);
            let trimmed = s.trim_end_matches(['\n', '\r']);
            if !trimmed.is_empty() {
                lines.push(trimmed.to_string());
            }
        }
        Ok(lines)
    }
}

/// `~/.claude/projects` — the dir holding every session's transcript. `None` if the
/// home dir can't be resolved.
pub fn cc_projects_dir() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("projects"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// `~/.claude/settings.json` — read-only here (the Phase-8 installer is plan-only;
/// no write path exists — ADR-20260617).
pub fn cc_settings_path() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("settings.json"))
}

/// Spawn the activity tail watcher. Returns a boxed handle; dropping it stops the
/// watch (held in `AppState.activity`). Emits `activity:event` per surfaced event
/// and `activity:dropped` with a cumulative overflow count.
pub fn spawn(app: AppHandle, state: Arc<Mutex<Option<PathBuf>>>) -> Result<Box<dyn Any + Send>, String> {
    let projects = cc_projects_dir().ok_or_else(|| "cannot resolve ~/.claude/projects".to_string())?;
    if !projects.is_dir() {
        return Err(format!("no CC projects dir at {}", projects.display()));
    }

    let (tx, rx) = mpsc::channel::<PathBuf>();
    let vault_root = state;
    let app_worker = app.clone();
    std::thread::spawn(move || {
        let mut tailers: HashMap<PathBuf, Tailer> = HashMap::new();
        let mut dropped: u64 = 0;
        let mut anomalies: u64 = 0;
        while let Ok(path) = rx.recv() {
            let read = {
                let tailer = tailers.entry(path.clone()).or_insert_with(|| Tailer::at_end(&path));
                tailer.read_new_lines(&path)
            };
            let lines = match read {
                Ok(l) => l,
                Err(e) => {
                    // File deleted (session ended/cleaned) → evict its tailer so the
                    // map can't grow across the app run; transient errors just skip.
                    if e.kind() == std::io::ErrorKind::NotFound {
                        tailers.remove(&path);
                    }
                    continue;
                }
            };
            let root = lock(&vault_root).clone();
            let root_str = root.as_ref().map(|p| p.to_string_lossy().to_string());
            let mut events: Vec<ActivityEvent> = Vec::new();
            let before_anom = anomalies;
            for line in &lines {
                // No vault open → classify against an unmatchable root so everything
                // is External (still streams all sessions, never renders a path).
                let c = classify_line(line, root_str.as_deref().unwrap_or("\0"));
                if c.anomaly {
                    anomalies += 1;
                }
                events.extend(c.events);
            }
            if anomalies != before_anom {
                let _ = app_worker.emit("activity:anomaly", serde_json::json!({ "anomalies": anomalies }));
            }
            if events.len() > MAX_EVENTS_PER_TICK {
                dropped += (events.len() - MAX_EVENTS_PER_TICK) as u64;
                let overflow = events.len() - MAX_EVENTS_PER_TICK;
                events.drain(..overflow); // drop OLDEST, keep most-recent
                let _ = app_worker.emit("activity:dropped", serde_json::json!({ "dropped": dropped }));
            }
            for ev in events {
                let _ = app_worker.emit("activity:event", ev);
            }
        }
    });

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let Ok(events) = result else {
                return;
            };
            for ev in events {
                for path in &ev.paths {
                    if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                        let _ = tx.send(path.clone());
                    }
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&projects, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(Box::new(debouncer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const ROOT: &str = r"C:\Users\dnoye\rose-glass";

    fn line(tool: &str, fp: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "sessionId": "dde54a71-c470-4576-a8ad-8d3edd2060ae",
            "message": { "content": [ { "type": "tool_use", "name": tool, "input": { "file_path": fp } } ] }
        })
        .to_string()
    }

    #[test]
    fn classify_in_vault_read_is_violet_pulse() {
        let evs = classify_line(&line("Read", r"C:\Users\dnoye\rose-glass\PROGRESS.md"), ROOT).events;
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            ActivityEvent::Vault { action, rel, session, .. } => {
                assert_eq!(*action, Action::Read);
                assert_eq!(rel, "PROGRESS.md");
                assert_eq!(session, "dde54a71");
            }
            _ => panic!("expected Vault"),
        }
    }

    #[test]
    fn classify_edit_write_is_modify() {
        for tool in ["Edit", "Write", "MultiEdit"] {
            let evs = classify_line(&line(tool, r"C:\Users\dnoye\rose-glass\notes\a.md"), ROOT).events;
            assert_eq!(evs.len(), 1);
            assert!(matches!(evs[0], ActivityEvent::Vault { action: Action::Modify, .. }));
        }
    }

    #[test]
    fn external_path_carries_no_path() {
        let evs = classify_line(&line("Read", r"C:\Users\dnoye\Settings_GT-BE98_Pro.md"), ROOT).events;
        assert_eq!(evs.len(), 1);
        // The External variant structurally has no path field — proven by serialization.
        let json = serde_json::to_string(&evs[0]).unwrap();
        assert!(matches!(evs[0], ActivityEvent::External { .. }));
        assert!(!json.contains("Settings_GT-BE98_Pro"), "external event leaked a path: {json}");
        assert!(!json.contains("rel"));
    }

    #[test]
    fn dotdot_escape_fails_closed_to_external() {
        // The Skeptic's case: a path that prefix-matches the vault but escapes via ..
        let evs = classify_line(&line("Read", r"C:\Users\dnoye\rose-glass\..\..\Settings_GT-BE98_Pro.md"), ROOT).events;
        assert!(matches!(evs[0], ActivityEvent::External { .. }), "..-escape must be External");
    }

    #[test]
    fn windows_case_insensitive_in_vault() {
        let evs = classify_line(&line("Read", r"c:\users\dnoye\rose-glass\Note.md"), ROOT).events;
        assert!(matches!(&evs[0], ActivityEvent::Vault { rel, .. } if rel == "Note.md"));
    }

    #[test]
    fn non_assistant_and_non_tool_lines_yield_nothing() {
        assert!(classify_line(r#"{"type":"user","message":{"content":"hi"}}"#, ROOT).events.is_empty());
        assert!(classify_line(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#, ROOT).events.is_empty());
    }

    #[test]
    fn bash_and_other_tools_are_ignored() {
        let l = serde_json::json!({
            "type":"assistant","sessionId":"x",
            "message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}
        }).to_string();
        assert!(classify_line(&l, ROOT).events.is_empty());
    }

    #[test]
    fn parallel_tool_uses_in_one_line_all_surface() {
        let l = serde_json::json!({
            "type":"assistant","sessionId":"abcd1234",
            "message":{"content":[
                {"type":"tool_use","name":"Read","input":{"file_path": format!("{ROOT}\\a.md")}},
                {"type":"tool_use","name":"Write","input":{"file_path": format!("{ROOT}\\b.md")}}
            ]}
        }).to_string();
        let evs = classify_line(&l, ROOT).events;
        assert_eq!(evs.len(), 2);
    }

    // ── THE SPIKE: torn-line buffering + rotation across incremental reads ──
    #[test]
    fn tailer_buffers_torn_final_line_then_completes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let complete = line("Read", r"C:\Users\dnoye\rose-glass\PROGRESS.md");

        // Write one complete line + a TORN second line (no trailing newline).
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "{complete}\n{{\"type\":\"assist").unwrap();
        f.flush().unwrap();

        let mut t = Tailer::default(); // offset 0 (read history) for the test
        let first = t.read_new_lines(&path).unwrap();
        assert_eq!(first.len(), 1, "only the complete line surfaces; torn line is buffered");
        assert_eq!(classify_line(&first[0], ROOT).events.len(), 1);

        // Append the rest of the torn line + newline.
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        let rest = r#"ant","sessionId":"z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"C:\\Users\\dnoye\\rose-glass\\z.md"}}]}}"#;
        writeln!(f, "{rest}").unwrap();
        f.flush().unwrap();

        let second = t.read_new_lines(&path).unwrap();
        assert_eq!(second.len(), 1, "the completed line now surfaces");
        assert!(matches!(classify_line(&second[0], ROOT).events[0], ActivityEvent::Vault { action: Action::Modify, .. }));

        // No new bytes → nothing.
        assert!(t.read_new_lines(&path).unwrap().is_empty());
    }

    #[test]
    fn tailer_resyncs_on_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let l = line("Read", r"C:\Users\dnoye\rose-glass\a.md");
        std::fs::write(&path, format!("{l}\n{l}\n")).unwrap();
        let mut t = Tailer::default();
        assert_eq!(t.read_new_lines(&path).unwrap().len(), 2);
        // Rotation: file shrinks (new session file reuses the path / truncation).
        std::fs::write(&path, format!("{l}\n")).unwrap();
        let after = t.read_new_lines(&path).unwrap();
        assert_eq!(after.len(), 1, "shrink detected → resync from 0, re-read the single line");
    }

    #[test]
    fn at_end_skips_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let l = line("Read", r"C:\Users\dnoye\rose-glass\a.md");
        std::fs::write(&path, format!("{l}\n{l}\n")).unwrap();
        let mut t = Tailer::at_end(&path); // seek to EOF — ignore the 2 historical lines
        assert!(t.read_new_lines(&path).unwrap().is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{l}").unwrap();
        f.flush().unwrap();
        assert_eq!(t.read_new_lines(&path).unwrap().len(), 1, "only post-attach activity streams");
    }

    // ── Review-fix regressions ──

    #[test]
    fn malformed_complete_line_is_flagged_anomaly_not_swallowed() {
        // A complete (newline-delimited) line that isn't valid JSON = drift signal.
        let c = classify_line("not json at all {{{", ROOT);
        assert!(c.events.is_empty());
        assert!(c.anomaly, "a malformed complete line must flag schema-drift");
        // valid JSON that just isn't file-touching is NOT an anomaly
        assert!(!classify_line(r#"{"type":"user"}"#, ROOT).anomaly);
        assert!(!classify_line("   ", ROOT).anomaly, "blank line is not an anomaly");
    }

    #[test]
    fn tailer_resyncs_past_a_runaway_newlineless_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runaway.jsonl");
        // > MAX_PARTIAL_BYTES with no newline → buffer must reset, not grow unbounded.
        let blob = "x".repeat(MAX_PARTIAL_BYTES + 1024);
        std::fs::write(&path, &blob).unwrap();
        let mut t = Tailer::default();
        assert!(t.read_new_lines(&path).unwrap().is_empty(), "no complete line yet");
        // then a real complete line lands and parses (we resynced past the garbage)
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "\n{}", line("Read", r"C:\Users\dnoye\rose-glass\a.md")).unwrap();
        f.flush().unwrap();
        let lines = t.read_new_lines(&path).unwrap();
        assert!(lines.iter().any(|l| !classify_line(l, ROOT).events.is_empty()), "recovers after the runaway line");
    }

    #[test]
    fn generation_gates_serialize_start_and_stop() {
        // A newer/equal start already owning the tail → don't re-spawn.
        assert!(!should_start(5, true, 5));
        assert!(!should_start(6, true, 5));
        // No watcher, or an older generation → spawn.
        assert!(should_start(5, false, 5));
        assert!(should_start(4, true, 5));
        // A stale stop (older gen) must NOT clear a newer start's watcher.
        assert!(!should_stop(6, 5));
        // A current/older-or-equal stop clears.
        assert!(should_stop(5, 5));
        assert!(should_stop(4, 5));
    }
}
