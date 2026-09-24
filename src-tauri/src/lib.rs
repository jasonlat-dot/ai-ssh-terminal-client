mod chat_history;

use chat_history::{list_chat_sessions, load_chat_session, save_chat_session, ChatHistoryState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ChatHistoryState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_chat_session,
            list_chat_sessions,
            load_chat_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
