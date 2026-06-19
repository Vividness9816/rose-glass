mod activity;
mod cluster;
mod commands;
mod installer;
pub mod db; // exposed for the rose-glass-mcp sidecar bin (read surface — §14)
mod embed;
mod fs_safe;
mod indexer;
mod knn;
mod state;
mod terminal;
mod watcher;

use state::AppState;
use terminal::TerminalRegistry;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
