use crate::sftp::{self, Result};
use serde_json::Value;
use std::sync::Arc;
use tauri::{ipc::Channel, AppHandle, State};

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Named IPC parameters preserve the existing sftp_open contract.
pub async fn sftp_open(
    app: AppHandle,
    state: State<'_, sftp::State>,
    backend_url: String,
    connection_id: String,
    root_path: Option<String>,
    access_mode: Option<shellpilot_server::sftp::model::AccessMode>,
    sudo_password: Option<String>,
    terminal_session_id: Option<String>,
    on_event: Channel<Value>,
) -> Result<Value> {
    let services = crate::backend_ipc::services_for_url(&app, &backend_url)
        .map_err(|error| sftp::Error { message: error.message, code: error.code, status: error.status })?;
    let request = shellpilot_server::sftp::model::OpenRequest {
        connection_id, root_path, access_mode: access_mode.unwrap_or_default(), sudo_password,
    };
    let emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    if let Some(terminal) = terminal_session_id {
        state.open_terminal_local(services, request, Some(&terminal), emit).await
    } else { state.open_local(services, request, emit).await }
}
#[tauri::command]
pub async fn sftp_close(state: State<'_, sftp::State>, session_id: String) -> Result<()> {
    state.close(&session_id).await
}
#[tauri::command]
pub async fn sftp_entries(
    state: State<'_, sftp::State>,
    session_id: String,
    path: String,
) -> Result<Value> {
    state.entries(&session_id, &path).await
}
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, sftp::State>,
    session_id: String,
    path: String,
) -> Result<()> {
    state.mkdir(&session_id, &path).await
}
#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, sftp::State>,
    session_id: String,
    path: String,
) -> Result<()> {
    state.create_file(&session_id, &path).await
}
#[tauri::command]
pub async fn sftp_delete_entry(
    state: State<'_, sftp::State>,
    session_id: String,
    path: String,
) -> Result<()> {
    state.delete_entry(&session_id, &path).await
}
#[tauri::command]
pub async fn sftp_tasks(state: State<'_, sftp::State>, session_id: String) -> Result<Value> {
    state.tasks(&session_id).await
}
#[tauri::command]
pub async fn sftp_transfer(
    state: State<'_, sftp::State>,
    session_id: String,
    direction: String,
    local_path: String,
    remote_path: String,
    conflict: String,
) -> Result<()> {
    state
        .transfer(&session_id, &direction, local_path, remote_path, &conflict)
        .await
}
#[tauri::command]
pub async fn sftp_retry(
    state: State<'_, sftp::State>,
    session_id: String,
    transfer_id: String,
) -> Result<()> {
    state.retry(&session_id, &transfer_id).await
}
#[tauri::command]
pub async fn sftp_cancel(
    state: State<'_, sftp::State>,
    session_id: String,
    transfer_id: String,
) -> Result<()> {
    state.cancel(&session_id, &transfer_id).await
}
#[tauri::command]
pub async fn sftp_local_entries(path: Option<String>) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || sftp::local_entries(path))
        .await
        .map_err(|e| sftp::Error::local(e.to_string()))?
}
#[tauri::command]
pub async fn sftp_local_mkdir(parent: String, name: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || sftp::local_mkdir(parent, name))
        .await
        .map_err(|e| sftp::Error::local(e.to_string()))?
}
#[tauri::command]
pub async fn sftp_local_create_file(parent: String, name: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || sftp::local_create_file(parent, name))
        .await
        .map_err(|e| sftp::Error::local(e.to_string()))?
}
#[tauri::command]
pub async fn sftp_local_delete(path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || sftp::local_delete(path))
        .await
        .map_err(|e| sftp::Error::local(e.to_string()))?
}
