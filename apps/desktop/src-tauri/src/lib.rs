mod commands;
mod db;
mod indexer;
mod state;
mod watcher;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Start on an in-memory schema so reads before a vault is opened don't
            // error; open_vault swaps in the vault's on-disk index.db.
            let conn = db::open_in_memory()?;
            db::migrate(&conn)?;
            app.manage(AppState::new(conn));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
