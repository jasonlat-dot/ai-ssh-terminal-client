mod cache;
mod bundled_backend;
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
    let app = tauri::Builder::default()
        .manage(ChatHistoryState::default())
        .manage(bundled_backend::BundledBackendState::default())
        .manage(LocalTerminalState::default())
        .manage(sftp::State::default())
        .manage(CommandStoreState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            /*
             * 后端启动失败不能阻止桌面窗口打开，否则用户只能看到“应用没有反应”。
             * start 会保存真实失败原因，页面加载后通过命令读取并展示，同时允许用户重试。
             */
            bundled_backend::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bundled_backend::bundled_backend_status,
            bundled_backend::bundled_backend_restart,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            bundled_backend::stop(app_handle);
        }
    });
}
