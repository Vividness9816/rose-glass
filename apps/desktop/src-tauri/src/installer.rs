//! Phase 8 — M2 global-hook installer: PLAN + VALIDATORS + UNINSTALL, PURE ONLY.
//! ADR-20260617 ("build the aiming, not the trigger").
//!
//! This module computes WHAT arming the Rose Glass activity hook would do to
//! `~/.claude/settings.json`, validates that every pre-existing hook command
//! survives (SET-EQUALITY of command strings — never a count; the ADR's binding
//! check, because a count passes a merge that silently *replaces* a safety hook),
//! and computes the uninstall (round-trip).
//!
//! THERE IS NO `fs::write` IN THIS MODULE. It cannot mutate `settings.json`. Arming
//! the live mutation is a deliberate, attended, user-OK'd FUTURE act, gated behind
//! explicit confirmation + a printed timestamped backup + this dry-run diff. The
//! mechanism shipped for A6 is M1 (transcript-tail, `activity.rs`); M2 is the
//! deferred latency enhancement whose *plan* is captured-and-tested here.

use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Marker inside OUR hook command — makes install idempotent and lets uninstall find
/// exactly our entry (never a foreign one) to remove.
pub const HOOK_MARKER: &str = "rose-glass-activity";

/// The PostToolUse entry Rose Glass would add. File-append variant (no network — the
/// app tails the activity file for lower latency than waiting on the full transcript
/// flush). ponytail: the exact command is finalized at arming time; this is a
/// well-formed, marked entry so the merge/validate/uninstall logic is proven now.
pub fn rose_glass_hook_entry() -> Value {
    json!({
        "matcher": "Read|Edit|Write|MultiEdit",
        "hooks": [{
            "type": "command",
            "command": format!("node \"$ROSE_GLASS_ACTIVITY_HOOK\" # {HOOK_MARKER}"),
            "timeout": 5
        }]
    })
}

/// Every hook command string across all events — the unit of comparison for the
/// safety check (a set so order/duplication don't matter).
pub fn collect_commands(settings: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Some(hooks) = settings.get("hooks").and_then(|h| h.as_object()) else {
        return out;
    };
    for arr in hooks.values() {
        let Some(arr) = arr.as_array() else { continue };
        for entry in arr {
            let Some(inner) = entry.get("hooks").and_then(|h| h.as_array()) else {
                continue;
            };
            for h in inner {
                if let Some(cmd) = h.get("command").and_then(|c| c.as_str()) {
                    out.insert(cmd.to_string());
                }
            }
        }
    }
    out
}

pub struct InstallPlan {
    pub already_installed: bool,
    /// settings WITH our hook (computed only — NEVER written to disk).
    pub merged: Value,
    pub added_command: String,
}

/// Compute the install plan. Pure — no filesystem access, no write. Errors if the
/// settings doc isn't shaped as expected (so we never produce a malformed plan).
pub fn plan_install(settings_json: &str) -> Result<InstallPlan, String> {
    let mut settings: Value = serde_json::from_str(settings_json).map_err(|e| e.to_string())?;
    if !settings.is_object() {
        return Err("settings.json is not a JSON object".into());
    }
    let entry = rose_glass_hook_entry();
    let added_command = entry["hooks"][0]["command"]
        .as_str()
        .expect("hook entry command is a string literal")
        .to_string();

    let already = collect_commands(&settings)
        .iter()
        .any(|c| c.contains(HOOK_MARKER));

    if !already {
        let obj = settings.as_object_mut().expect("checked is_object above");
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        if !hooks.is_object() {
            return Err("settings.hooks is not an object".into());
        }
        let post = hooks
            .as_object_mut()
            .expect("checked is_object above")
            .entry("PostToolUse")
            .or_insert_with(|| json!([]));
        if !post.is_array() {
            return Err("settings.hooks.PostToolUse is not an array".into());
        }
        post.as_array_mut()
            .expect("checked is_array above")
            .push(entry);
    }

    Ok(InstallPlan {
        already_installed: already,
        merged: settings,
        added_command,
    })
}

/// THE BINDING SAFETY CHECK (ADR-20260616/20260617): every pre-existing hook command
/// survives the merge, and EXACTLY our one command is added — set-equality, not a
/// count. Catches the catastrophic "valid JSON but a safety hook was silently
/// dropped/replaced" case the council named.
pub fn validate_install(original_json: &str, plan: &InstallPlan) -> Result<(), String> {
    let original: Value = serde_json::from_str(original_json).map_err(|e| e.to_string())?;
    let before = collect_commands(&original);
    let after = collect_commands(&plan.merged);

    for c in &before {
        if !after.contains(c) {
            return Err(format!("install would DROP or ALTER an existing hook: {c}"));
        }
    }
    if plan.already_installed {
        if after != before {
            return Err("idempotent re-install changed the command set".into());
        }
    } else {
        let mut expect = before.clone();
        expect.insert(plan.added_command.clone());
        if after != expect {
            return Err("install added more than the single rose-glass hook".into());
        }
    }
    Ok(())
}

/// Compute the uninstall: remove ONLY entries whose command carries our marker. Pure
/// — no write.
pub fn plan_uninstall(settings_json: &str) -> Result<Value, String> {
    let mut settings: Value = serde_json::from_str(settings_json).map_err(|e| e.to_string())?;
    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for arr in hooks.values_mut() {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|entry| !entry_has_marker(entry));
            }
        }
    }
    Ok(settings)
}

fn entry_has_marker(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|inner| {
            inner.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains(HOOK_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Human-readable DRY RUN (no write): what install would change + whether uninstall
/// round-trips the command set. This is the affordance the live-arming step would
/// print before any (future) write.
pub fn dry_run_summary(settings_json: &str) -> Result<String, String> {
    let plan = plan_install(settings_json)?;
    validate_install(settings_json, &plan)?;
    let before = collect_commands(&serde_json::from_str(settings_json).map_err(|e| e.to_string())?);
    let merged_json = serde_json::to_string(&plan.merged).map_err(|e| e.to_string())?;
    let after_uninstall = collect_commands(&plan_uninstall(&merged_json)?);
    let roundtrips = after_uninstall == before;
    Ok(format!(
        "DRY RUN — no settings.json write. already_installed={} · existing_hooks_preserved={} · would_add={} · uninstall_roundtrips={}",
        plan.already_installed,
        before.len(),
        if plan.already_installed { 0 } else { 1 },
        roundtrips
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A structurally-faithful synthetic settings.json: 6 event types, 17 hook
    /// commands, mixed runtimes (node full-path / bash / powershell -ExecutionPolicy
    /// / python), a TRAILING `# comment` inside a command (the live-file quirk), and
    /// the safety-hook command names — but synthetic paths (never the user's real
    /// config). The quirks are what the merge must round-trip (council requirement).
    fn fixture() -> &'static str {
        r##"{
          "permissions": { "defaultMode": "bypassPermissions" },
          "model": "opus",
          "hooks": {
            "SessionStart": [
              { "hooks": [ { "type":"command", "command":"\"C:/Program Files/nodejs/node.exe\" \"C:/x/gsd-check-update.js\"" } ] },
              { "matcher":"startup|resume", "hooks":[ { "type":"command", "command":"powershell -NoProfile -ExecutionPolicy Bypass -File \"C:/x/cc-session-hook.ps1\"", "timeout":20 } ] }
            ],
            "PostToolUse": [
              { "matcher":"Bash|Edit|Write", "hooks":[ { "type":"command", "command":"\"C:/Program Files/nodejs/node.exe\" \"C:/x/gsd-context-monitor.js\"", "timeout":10 } ] },
              { "matcher":"Write", "hooks":[ { "type":"command", "command":"node \"C:/x/gsd-lessons-capture.js\"", "timeout":5 } ] },
              { "matcher":"Skill|Agent", "hooks":[ { "type":"command", "command":"node \"C:/x/emitter.mjs\" # neural-wallpaper/hook/emitter.mjs", "timeout":5 } ] },
              { "matcher":"Read", "hooks":[ { "type":"command", "command":"\"C:/Program Files/nodejs/node.exe\" \"C:/x/gsd-read-injection-scanner.js\"", "timeout":5 } ] }
            ],
            "PreToolUse": [
              { "matcher":"Write|Edit", "hooks":[ { "type":"command", "command":"\"C:/Program Files/nodejs/node.exe\" \"C:/x/gsd-prompt-guard.js\"", "timeout":5 } ] },
              { "matcher":"Write|Edit", "hooks":[ { "type":"command", "command":"\"C:/Program Files/nodejs/node.exe\" \"C:/x/gsd-read-guard.js\"", "timeout":5 } ] },
              { "matcher":"Bash", "hooks":[ { "type":"command", "command":"bash \"C:/x/gsd-validate-commit.sh\"", "timeout":5 } ] },
              { "matcher":"Bash", "hooks":[ { "type":"command", "command":"node \"C:/x/self-audit-commit-guard.js\"", "timeout":10 } ] },
              { "matcher":"Skill", "hooks":[ { "type":"command", "command":"node \"C:/x/security-sweep-milestone-guard.js\"", "timeout":10 } ] }
            ],
            "UserPromptSubmit": [
              { "hooks":[ { "type":"command", "command":"node \"C:/x/gsd-lessons-surface.js\"", "timeout":5 } ] },
              { "hooks":[ { "type":"command", "command":"node \"C:/x/security-sweep-milestone-guard.js\"", "timeout":10 } ] }
            ],
            "Stop": [
              { "hooks":[ { "type":"command", "command":"node \"C:/x/emitter.mjs\" # neural-wallpaper/hook/emitter.mjs", "timeout":5 } ] },
              { "hooks":[ { "type":"command", "command":"powershell -NoProfile -ExecutionPolicy Bypass -File \"C:/x/elevenlabs-tts.ps1\"", "timeout":300, "async":true } ] },
              { "hooks":[ { "type":"command", "command":"\"C:/Python314/python.exe\" \"C:/x/vaultforge-session-capture.py\"", "timeout":20 } ] }
            ]
          }
        }"##
    }

    #[test]
    fn plan_install_adds_exactly_one_marked_hook_and_validates() {
        let f = fixture();
        let before = collect_commands(&serde_json::from_str(f).unwrap());
        let plan = plan_install(f).unwrap();
        assert!(!plan.already_installed);
        let after = collect_commands(&plan.merged);
        assert_eq!(after.len(), before.len() + 1, "exactly one command added");
        assert!(after.iter().any(|c| c.contains(HOOK_MARKER)));
        // every original safety hook still present
        for safety in [
            "gsd-prompt-guard.js",
            "gsd-read-injection-scanner.js",
            "self-audit-commit-guard.js",
            "security-sweep-milestone-guard.js",
            "gsd-read-guard.js",
        ] {
            assert!(after.iter().any(|c| c.contains(safety)), "dropped safety hook {safety}");
        }
        validate_install(f, &plan).expect("merge preserves all 17 + adds 1");
    }

    #[test]
    fn install_is_idempotent() {
        let f = fixture();
        let once = plan_install(f).unwrap();
        let once_json = serde_json::to_string(&once.merged).unwrap();
        let twice = plan_install(&once_json).unwrap();
        assert!(twice.already_installed, "second install detects our marker");
        assert_eq!(
            collect_commands(&once.merged),
            collect_commands(&twice.merged),
            "re-install is a no-op on the command set"
        );
        validate_install(&once_json, &twice).unwrap();
    }

    #[test]
    fn uninstall_round_trips_the_command_set() {
        let f = fixture();
        let before = collect_commands(&serde_json::from_str(f).unwrap());
        let plan = plan_install(f).unwrap();
        let merged_json = serde_json::to_string(&plan.merged).unwrap();
        let restored = plan_uninstall(&merged_json).unwrap();
        assert_eq!(
            collect_commands(&restored),
            before,
            "uninstall(install(x)) restores the exact original command set"
        );
        // and our marker is gone
        assert!(!collect_commands(&restored).iter().any(|c| c.contains(HOOK_MARKER)));
    }

    #[test]
    fn validate_rejects_a_dropped_safety_hook() {
        // Simulate a BAD merge that silently drops the read-injection-scanner.
        let f = fixture();
        let mut bad: Value = serde_json::from_str(f).unwrap();
        let post = bad["hooks"]["PostToolUse"].as_array_mut().unwrap();
        post.retain(|e| {
            !serde_json::to_string(e).unwrap().contains("gsd-read-injection-scanner")
        });
        let bad_plan = InstallPlan {
            already_installed: false,
            merged: bad,
            added_command: rose_glass_hook_entry()["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .to_string(),
        };
        let err = validate_install(f, &bad_plan).unwrap_err();
        assert!(err.contains("gsd-read-injection-scanner"), "must name the dropped hook: {err}");
    }

    #[test]
    fn rejects_non_object_settings() {
        assert!(plan_install("[]").is_err());
        assert!(plan_install("not json").is_err());
    }

    #[test]
    fn dry_run_summary_reports_preserved_and_roundtrip() {
        let s = dry_run_summary(fixture()).unwrap();
        assert!(s.contains("uninstall_roundtrips=true"), "{s}");
        assert!(s.contains("would_add=1"), "{s}");
    }

    /// Proves the plan against the REAL live settings.json on demand (no commit, no
    /// write) — the council's "validate against the real 17-hook file". #[ignore]d so
    /// it never runs in CI (the file isn't present there) and never touches the user
    /// config beyond a read.
    #[test]
    #[ignore = "reads the live ~/.claude/settings.json; run on demand"]
    fn validates_against_live_settings_json() {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(std::path::PathBuf::from)
            .expect("home dir");
        let path = home.join(".claude").join("settings.json");
        let json = std::fs::read_to_string(&path).expect("read live settings.json");
        let before = collect_commands(&serde_json::from_str(&json).unwrap());
        let plan = plan_install(&json).unwrap();
        validate_install(&json, &plan).expect("live merge preserves every hook");
        let merged = serde_json::to_string(&plan.merged).unwrap();
        let restored = collect_commands(&plan_uninstall(&merged).unwrap());
        assert_eq!(restored, before, "live uninstall round-trips");
        eprintln!("live settings.json: {} hooks preserved, +1 rose-glass", before.len());
    }
}
