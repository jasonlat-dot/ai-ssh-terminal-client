mod cache;
mod bundled_backend;
mod backend_process;
mod client_update;
mod local_backend_tls;
mod backend_connection_probe;
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
        .manage(local_backend_tls::LocalBackendTlsState::default())
        .manage(LocalTerminalState::default())
        .manage(sftp::State::default())
        .manage(CommandStoreState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 先注册本机证书固定信任，再开始后端启动，避免首次 HTTPS 请求早于事件安装。
            local_backend_tls::install(app.handle())?;
            /*
             * 后端健康检查最长需要 60 秒，不能阻塞 Tauri 主线程和 WebView 首次绘制。
             * 后台任务保存真实状态并发送变更事件；启动页订阅后读取一次快照，同时允许重试。
             *
             * 是否在启动时自动拉起本地后端，由 settings 中"自动启动内置后端"开关决定；
             * 关闭时停留在 stopped 状态，用户可以在启动页或设置页点"启动"按钮手动启。
             */
            bundled_backend::start_in_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            client_update::client_update_status,
            client_update::prepare_client_update,
            bundled_backend::bundled_backend_status,
            bundled_backend::prepare_local_backend_tls,
            local_backend_tls::configure_backend_connection_tls,
            backend_connection_probe::probe_backend_connection,
            bundled_backend::bundled_backend_restart,
            bundled_backend::bundled_backend_stop,
            bundled_backend::bundled_backend_config,
            bundled_backend::bundled_backend_save_config,
            bundled_backend::bundled_backend_get_auto_start,
            bundled_backend::bundled_backend_set_auto_start,
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
