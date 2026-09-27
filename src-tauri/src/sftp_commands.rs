use crate::sftp::{self, Result};
use serde_json::Value;
use std::sync::Arc;
use tauri::{ipc::Channel, State};

#[tauri::command]
pub async fn sftp_open(
    state: State<'_, sftp::State>,
    backend_url: String,
    connection_id: String,
    root_path: Option<String>,
    on_event: Channel<Value>,
) -> Result<Value> {
    state
        .open(
            backend_url,
            connection_id,
            root_path,
            Arc::new(move |event| {
                let _ = on_event.send(event);
            }),
        )
        .await
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
