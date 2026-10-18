use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateStatus {
    version: String,
    configured: bool,
    development: bool,
    supported: bool,
}

#[tauri::command]
pub fn client_update_status(app: AppHandle) -> ClientUpdateStatus {
    let updater = app.config().plugins.0.get("updater");
    let configured = updater.is_some_and(|config| {
        config
            .get("pubkey")
            .and_then(|value| value.as_str())
            .is_some_and(|key| !key.trim().is_empty())
            && config
                .get("endpoints")
                .and_then(|value| value.as_array())
                .is_some_and(|urls| {
                    !urls.is_empty()
                        && urls.iter().all(|value| {
                            value
                                .as_str()
                                .is_some_and(|url| url.starts_with("https://"))
                        })
                })
    });
    ClientUpdateStatus {
        version: app.package_info().version.to_string(),
        configured,
        development: cfg!(debug_assertions),
        // The current signed installer release pipeline targets Windows x64.
        supported: cfg!(all(target_os = "windows", target_arch = "x86_64")),
    }
}

/// Called only after the signed download is verified and the user confirms installation.
/// Stop the embedded workspace before the installer replaces application files.
#[tauri::command]
pub async fn prepare_client_update(app: AppHandle) -> Result<(), String> {
    let status = client_update_status(app.clone());
    if status.development || !status.supported || !status.configured {
        return Err("当前构建未启用客户端更新，不能启动安装。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Existing stop path affects only this application's owned process; no data/config deletion.
        crate::bundled_backend::stop(&app);
        // Frontend closes its sessions first; native local CMD cleanup also covers standalone settings.
        crate::local_terminal::close_all(&app.state::<crate::local_terminal::LocalTerminalState>());
    })
    .await
    .map_err(|error| format!("准备更新失败：{error}"))?;
    Ok(())
}
