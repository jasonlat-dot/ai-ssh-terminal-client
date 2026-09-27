mod cache;
mod chat_history;
mod command_store;
mod local_terminal;
mod sftp;
mod sftp_commands;

use chat_history::{list_chat_sessions, load_chat_session, save_chat_session, ChatHistoryState};
use command_store::{load_commands, save_commands, CommandStoreState};
use local_terminal::{
    local_terminal_close, local_terminal_open, local_terminal_resize, local_terminal_write,
    LocalTerminalState,
};
use sftp_commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ChatHistoryState::default())
        .manage(LocalTerminalState::default())
        .manage(sftp::State::default())
        .manage(CommandStoreState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            sftp_open,
            sftp_close,
            sftp_entries,
            sftp_mkdir,
            sftp_create_file,
            sftp_delete_entry,
            sftp_tasks,
            sftp_transfer,
            sftp_retry,
            sftp_cancel,
            sftp_local_entries,
            sftp_local_mkdir,
            sftp_local_create_file,
            sftp_local_delete,
            local_terminal_open,
            local_terminal_write,
            local_terminal_resize,
            local_terminal_close,
            save_chat_session,
            list_chat_sessions,
            load_chat_session,
            load_commands,
            save_commands,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
