mod backend_ipc;
#[path = "embedded_backend.rs"]
mod bundled_backend;
mod cache;

mod chat_history;
mod client_update;
mod command_store;
mod data_migration;
mod local_terminal;
mod sftp;
mod sftp_commands;
mod tray;

use chat_history::{list_chat_sessions, load_chat_session, save_chat_session, ChatHistoryState};
use command_store::{load_commands, save_commands, CommandStoreState};
use local_terminal::{
    local_terminal_close, local_terminal_open, local_terminal_resize, local_terminal_write,
    LocalTerminalState,
};
use sftp_commands::*;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Register first, before opening windows or initializing the workspace.
    // Taskbar/Start menu launches wake the tray instance and exit immediately.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        tray::show_main_window(app);
    }));

    let app = builder
        .plugin(data_migration::plugin())
        .manage(backend_ipc::IpcState::default())
        .manage(ChatHistoryState::default())
        .manage(bundled_backend::BundledBackendState::default())
        .manage(LocalTerminalState::default())
        .manage(sftp::State::default())
        .manage(CommandStoreState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Install first: never hide the main window without a way to restore it.
            tray::install(app)?;
            /*
             * Initialize local services on their own runtime without an HTTP listener.
             * SQLite and file initialization must not block the window thread.
             * The startup screen consumes the status snapshot and subsequent events.
             */
            bundled_backend::start_in_background(app.handle().clone());
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            backend_ipc::builtin_request,
            backend_ipc::builtin_cancel,
            backend_ipc::builtin_terminal_subscribe,
            backend_ipc::builtin_agent_subscribe,
            backend_ipc::builtin_agent_ack,
            backend_ipc::builtin_terminal_unsubscribe,
            backend_ipc::builtin_terminal_ack,
            backend_ipc::builtin_pick_upload,
            backend_ipc::builtin_clipboard_upload,
            backend_ipc::builtin_attachment_preview,
            backend_ipc::builtin_save_attachment,
            client_update::client_update_status,
            client_update::prepare_client_update,
            bundled_backend::bundled_backend_status,
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
            local_terminal::close_all(&app_handle.state::<LocalTerminalState>());
        }
    });
}
