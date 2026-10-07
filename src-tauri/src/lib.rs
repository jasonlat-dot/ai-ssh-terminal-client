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
             * 后端健康检查最长需要 60 秒，不能阻塞 Tauri 主线程和 WebView 首次绘制。
             * 后台任务会保存真实状态，启动页通过命令轮询并展示，同时允许用户重试。
             */
            bundled_backend::start_in_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bundled_backend::bundled_backend_status,
            bundled_backend::bundled_backend_restart,
            bundled_backend::bundled_backend_config,
            bundled_backend::bundled_backend_save_config,
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
