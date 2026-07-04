mod commands;
pub mod db;
pub mod extraction;
pub mod mcp;
mod ollama;
pub mod web;

use commands::AppState;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::create_room,
            commands::open_room,
            commands::close_room,
            commands::room_info,
            commands::take_pending_open,
            commands::import_files,
            commands::list_files,
            commands::get_file_content,
            commands::update_file_content,
            commands::set_cell,
            commands::delete_file,
            commands::save_generated_file,
            commands::list_file_versions,
            commands::restore_file_version,
            commands::export_file,
            commands::export_all,
            commands::change_password,
            commands::duplicate_room,
            commands::compact_room,
            commands::list_recent,
            commands::remove_recent,
            commands::clear_recent,
            commands::add_memory,
            commands::list_memories,
            commands::delete_memory,
            commands::get_setting,
            commands::set_setting,
            commands::web_search_test,
            commands::mcp_get_config,
            commands::mcp_apply_config,
            commands::mcp_status,
            commands::ai_status,
            commands::warm_model,
            commands::pull_model,
            commands::delete_model,
            commands::list_chats,
            commands::create_chat,
            commands::delete_chat,
            commands::get_messages,
            commands::ask,
            commands::locate_in_image,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Finder double-click on a .roomai file lands here on macOS.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let path = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .next();
                if let Some(path) = path {
                    let state = _app.state::<AppState>();
                    *state.pending_open.lock().unwrap() = Some(path.clone());
                    if let Some(window) = _app.get_webview_window("main") {
                        let _ = window.emit("open-room-file", path);
                    }
                }
            }
        });
}
