mod cache;
mod chat_history;
mod command_store;

use chat_history::{list_chat_sessions, load_chat_session, save_chat_session, ChatHistoryState};
use command_store::{load_commands, save_commands, CommandStoreState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ChatHistoryState::default())
        .manage(CommandStoreState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_chat_session,
            list_chat_sessions,
            load_chat_session,
            load_commands,
            save_commands,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
