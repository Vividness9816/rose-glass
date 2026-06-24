mod activity;
pub mod cluster; // exposed for the sidecar's `reembed` (read_texts + store_clusters — ADR-20260624)
mod commands;
mod installer;
pub mod capture; // the single confined agent write path (file-first, sync-indexed — ADR-20260623)
pub mod db; // exposed for the rose-glass-mcp sidecar bin (read surface — §14)
pub mod embed; // exposed for the sidecar's `reembed`/`semantic_search` model (ADR-20260624)
pub mod fs_safe; // exposed for the rose-glass-mcp sidecar's confined write path (ADR-20260623)
pub mod indexer; // exposed so the sidecar can self-index via pipeline::incremental (app-closed case)
pub mod knn; // exposed for the sidecar's `semantic_search` ranking (ADR-20260624)
mod state;
mod terminal;
mod watcher;

use state::{lock, AppState};
use terminal::TerminalRegistry;
use tauri::{Emitter, Manager};

/// Extensions Rose Glass can open from the OS (matches the bundle fileAssociations +
/// what ingest_dropped_file accepts).
const OPENABLE_EXTS: &[&str] = &["md", "markdown", "txt", "pdf", "docx"];

/// First arg after argv[0] that is an existing file with an openable extension — the path a
/// file double-click hands us. Shared by the cold start (our own argv) and the warm
/// single-instance callback (a 2nd launch's argv).
fn first_openable_file(argv: &[String]) -> Option<String> {
    argv.iter()
        .skip(1)
        .find(|a| {
            let p = std::path::Path::new(a.as_str());
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| OPENABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                    .unwrap_or(false)
        })
        .cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // MUST be the FIRST plugin: it intercepts a 2nd launch before any window work. The
        // callback fires in the PRIMARY instance with the 2nd launch's argv — focus us and
        // forward the clicked file to the frontend, which opens it via the ingest path.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if let Some(path) = first_openable_file(&argv) {
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // Start on an in-memory schema so reads before a vault is opened don't
            // error; open_vault swaps in the vault's on-disk index.db.
            let conn = db::open_in_memory()?;
            db::migrate(&conn)?;
            app.manage(AppState::new(conn));
            app.manage(TerminalRegistry::default());
            // Cold start: if WE were launched by a file double-click, stash the path so the
            // frontend can open it once the webview is ready (the single-instance callback
            // only fires for the 2nd+ launch, never our own first launch).
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = first_openable_file(&args) {
                *lock(&app.state::<AppState>().pending_open_file) = Some(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::reindex,
            commands::get_note,
            commands::get_backlinks,
            commands::search,
            commands::get_tags,
            commands::get_graph_payload,
            commands::read_note_file,
            commands::save_note_file,
            commands::read_file_bytes,
            commands::file_size,
            commands::resolve_link,
            commands::recompute_clusters,
            commands::related_notes,
            commands::semantic_search,
            commands::retry_embedding_model,
            commands::ingest_dropped_file,
            commands::take_pending_open_file,
            commands::activity_start,
            commands::activity_stop,
            commands::activity_hook_plan,
            commands::activity_hook_arm,
            commands::activity_hook_disarm,
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            terminal::pty_attach,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
