//! Rust preview: backend runs inside the Tauri process, with its own runtime.
//! The desktop owns startup, shutdown and configuration; no JVM or child server.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread::{self, JoinHandle},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

const EVENT: &str = "bundled-backend-status-changed";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    revision: u64,
    status: String,
    message: String,
    log_path: Option<String>,
    backend_url: Option<String>,
    engine: &'static str,
}
impl Default for BackendStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            status: "stopped".into(),
            message: "Rust 内置服务尚未启动".into(),
            log_path: None,
            backend_url: None,
            engine: "rust",
        }
    }
}
struct Running {
    cancel: CancellationToken,
    thread: JoinHandle<()>,
}
#[derive(Default)]
pub struct BundledBackendState {
    running: Mutex<Option<Running>>,
    status: Mutex<BackendStatus>,
    lifecycle: Mutex<()>,
    generation: AtomicU64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    server_port: u16,
    data_directory: Option<PathBuf>,
    auto_start: bool,
    file_storage_enabled: bool,
    max_storage_mib: u64,
    file_retention_days: u64,
    download_link_minutes: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            server_port: 0,
            data_directory: None,
            auto_start: true,
            file_storage_enabled: true,
            max_storage_mib: 1024,
            file_retention_days: 0,
            download_link_minutes: 15,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfigValue {
    value: String,
    source_file: String,
    environment_override: Option<String>,
    configured: bool,
    sensitive: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfigView {
    config_directory: String,
    application_file: String,
    active_profiles: Vec<String>,
    values: BTreeMap<String, BackendConfigValue>,
    sqlite_file: String,
    upload_directory: String,
    log_directory: String,
    ssl_enabled: bool,
    engine: &'static str,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfigUpdate {
    values: BTreeMap<String, String>,
}

fn home(app: &AppHandle) -> io::Result<PathBuf> {
    app.path().app_local_data_dir().map_err(io::Error::other)
}
fn config_file(app: &AppHandle) -> io::Result<PathBuf> {
    Ok(home(app)?.join("rust-backend.json"))
}
fn load(path: &Path) -> io::Result<Settings> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e),
    }
}
fn persist(path: &Path, settings: &Settings) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("配置目录无效"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(settings)?)?;
    if path.is_file() {
        fs::copy(path, path.with_extension("json.bak"))?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}
fn data_directory(app: &AppHandle, settings: &Settings) -> io::Result<PathBuf> {
    Ok(settings
        .data_directory
        .clone()
        .unwrap_or(home(app)?.join("backend-data")))
}
fn file_settings(settings: &Settings) -> shellpilot_server::files::Settings {
    shellpilot_server::files::Settings {
        enabled: settings.file_storage_enabled,
        max_storage_bytes: settings.max_storage_mib.saturating_mul(1024 * 1024),
        retention: (settings.file_retention_days > 0).then(|| {
            std::time::Duration::from_secs(settings.file_retention_days.saturating_mul(86400))
        }),
        download_ttl: std::time::Duration::from_secs(
            settings.download_link_minutes.saturating_mul(60),
        ),
        ..Default::default()
    }
}
fn append_log(path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {message}", chrono::Utc::now().to_rfc3339());
    }
}
fn publish(
    app: &AppHandle,
    status: &str,
    message: impl Into<String>,
    url: Option<String>,
) -> BackendStatus {
    let state = app.state::<BundledBackendState>();
    let mut current = state.status.lock().unwrap();
    current.revision += 1;
    current.status = status.into();
    current.message = message.into();
    current.backend_url = url;
    current.log_path = home(app)
        .ok()
        .map(|p| p.join("logs/backend.log").to_string_lossy().into_owned());
    let result = current.clone();
    drop(current);
    let _ = app.emit(EVENT, &result);
    result
}
fn stop_inner(app: &AppHandle) {
    let state = app.state::<BundledBackendState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    let running = state.running.lock().unwrap().take();
    if let Some(running) = running {
        running.cancel.cancel();
        // serve() closes terminal readers and transports before graceful HTTP shutdown.
        let _ = running.thread.join();
    }
}
fn start_inner(app: &AppHandle) -> Result<BackendStatus, String> {
    let root = home(app).map_err(|e| e.to_string())?;
    let path = config_file(app).map_err(|e| e.to_string())?;
    let settings = load(&path).map_err(|e| e.to_string())?;
    if !path.exists() {
        persist(&path, &settings).map_err(|e| e.to_string())?;
    }
    let data = data_directory(app, &settings).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("logs")).map_err(|e| e.to_string())?;
    let log = root.join("logs/backend.log");
    let store = std::sync::Arc::new(
        shellpilot_server::store::Store::open(&data.join("shellpilot.sqlite3"))
            .map_err(|e| e.to_string())?,
    );
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, settings.server_port))
        .map_err(|e| format!("无法监听本机端口：{e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let url = format!(
        "http://{}",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let file_settings = file_settings(&settings);
    let stopping = cancel.clone();
    let app_handle = app.clone();
    let state = app.state::<BundledBackendState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    append_log(&log, &format!("starting embedded Rust backend at {url}"));
    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    let thread = thread::spawn(move || {
        let result = runtime.block_on(async {
            let listener = tokio::net::TcpListener::from_std(listener)?;
            let _ = ready_sender.send(());
            shellpilot_server::serve_with_file_settings(
                listener,
                store,
                file_settings,
                stopping.clone().cancelled_owned(),
            )
            .await
        });
        append_log(
            &log,
            if result.is_ok() {
                "embedded Rust backend stopped"
            } else {
                "embedded Rust backend failed"
            },
        );
        let state = app_handle.state::<BundledBackendState>();
        if !stopping.is_cancelled() && state.generation.load(Ordering::SeqCst) == generation {
            publish(
                &app_handle,
                "failed",
                format!(
                    "Rust 内置服务已退出：{}",
                    result
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "意外停止".into())
                ),
                None,
            );
        }
    });
    if ready_receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .is_err()
    {
        cancel.cancel();
        let _ = thread.join();
        return Err("Rust 内置服务启动超时，请查看日志".into());
    }
    if thread.is_finished() {
        let _ = thread.join();
        return Err("Rust 内置服务启动后立即退出，请查看日志".into());
    }
    *state.running.lock().unwrap() = Some(Running { cancel, thread });
    Ok(publish(app, "running", "Rust 内置服务已就绪", Some(url)))
}
fn start_locked(app: &AppHandle) -> BackendStatus {
    publish(app, "starting", "正在启动 Rust 内置服务…", None);
    match start_inner(app) {
        Ok(status) => status,
        Err(error) => publish(app, "failed", error, None),
    }
}
pub fn start_in_background(app: AppHandle) {
    publish(&app, "starting", "正在启动 Rust 内置服务…", None);
    thread::spawn(move || {
        let state = app.state::<BundledBackendState>();
        let _guard = state.lifecycle.lock().unwrap();
        // A stop/restart command may have completed before this thread acquired the lock.
        if state.status.lock().unwrap().status != "starting" {
            return;
        }
        match config_file(&app).and_then(|p| load(&p)) {
            Ok(settings) if !settings.auto_start => {
                publish(
                    &app,
                    "stopped",
                    "自动启动已关闭，可手动启动 Rust 内置服务",
                    None,
                );
            }
            Ok(_) => {
                start_locked(&app);
            }
            Err(error) => {
                publish(&app, "failed", error.to_string(), None);
            }
        }
    });
}
pub fn stop(app: &AppHandle) {
    let state = app.state::<BundledBackendState>();
    let _guard = state.lifecycle.lock().unwrap();
    stop_inner(app);
    publish(app, "stopped", "Rust 内置服务已停止", None);
}
#[tauri::command]
pub fn bundled_backend_status(state: State<'_, BundledBackendState>) -> BackendStatus {
    state.status.lock().unwrap().clone()
}
#[tauri::command]
pub async fn bundled_backend_restart(app: AppHandle) -> Result<BackendStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BundledBackendState>();
        let _guard = state.lifecycle.lock().unwrap();
        stop_inner(&app);
        Ok(start_locked(&app))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn bundled_backend_stop(app: AppHandle) -> Result<BackendStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop(&app);
        Ok(app
            .state::<BundledBackendState>()
            .status
            .lock()
            .unwrap()
            .clone())
    })
    .await
    .map_err(|e| e.to_string())?
}
fn view(app: &AppHandle) -> io::Result<BackendConfigView> {
    let path = config_file(app)?;
    let settings = load(&path)?;
    let data = data_directory(app, &settings)?;
    let source = path.to_string_lossy().into_owned();
    let values = [
        ("serverPort", settings.server_port.to_string()),
        ("dataDirectory", data.to_string_lossy().into_owned()),
        (
            "fileStorageEnabled",
            settings.file_storage_enabled.to_string(),
        ),
        ("maxStorageMiB", settings.max_storage_mib.to_string()),
        (
            "fileRetentionDays",
            settings.file_retention_days.to_string(),
        ),
        (
            "downloadLinkMinutes",
            settings.download_link_minutes.to_string(),
        ),
    ]
    .into_iter()
    .map(|(key, value)| {
        (
            key.into(),
            BackendConfigValue {
                value,
                source_file: source.clone(),
                environment_override: None,
                configured: path.is_file(),
                sensitive: false,
            },
        )
    })
    .collect();
    Ok(BackendConfigView {
        config_directory: home(app)?.to_string_lossy().into_owned(),
        application_file: source,
        active_profiles: vec!["rust-preview".into()],
        values,
        sqlite_file: data
            .join("shellpilot.sqlite3")
            .to_string_lossy()
            .into_owned(),
        upload_directory: data.join("attachments").to_string_lossy().into_owned(),
        log_directory: home(app)?.join("logs").to_string_lossy().into_owned(),
        ssl_enabled: false,
        engine: "rust",
    })
}
fn apply(settings: &mut Settings, values: BTreeMap<String, String>) -> io::Result<()> {
    for (key, value) in values {
        match key.as_str() {
            "serverPort" => {
                settings.server_port = value
                    .parse()
                    .map_err(|_| io::Error::other("端口必须为 0（自动）或 1 到 65535"))?
            }
            "dataDirectory" => {
                let path = PathBuf::from(value.trim());
                if !path.is_absolute() || value.contains('\0') {
                    return Err(io::Error::other("数据目录必须是绝对路径"));
                }
                settings.data_directory = Some(path);
            }
            "fileStorageEnabled" => {
                settings.file_storage_enabled = value
                    .parse()
                    .map_err(|_| io::Error::other("附件开关必须为 true/false"))?;
            }
            "maxStorageMiB" => {
                settings.max_storage_mib = value
                    .parse()
                    .ok()
                    .filter(|v| (20..=102400).contains(v))
                    .ok_or_else(|| io::Error::other("附件容量必须为 20 到 102400 MiB"))?;
            }
            "fileRetentionDays" => {
                settings.file_retention_days = value
                    .parse()
                    .ok()
                    .filter(|v| *v <= 3650)
                    .ok_or_else(|| io::Error::other("保留天数必须为 0 到 3650"))?;
            }
            "downloadLinkMinutes" => {
                settings.download_link_minutes = value
                    .parse()
                    .ok()
                    .filter(|v| (1..=10080).contains(v))
                    .ok_or_else(|| io::Error::other("链接有效期必须为 1 到 10080 分钟"))?;
            }
            _ => return Err(io::Error::other("Rust 试用版不支持此配置项")),
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn bundled_backend_config(app: AppHandle) -> Result<BackendConfigView, String> {
    tauri::async_runtime::spawn_blocking(move || view(&app).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn bundled_backend_save_config(
    app: AppHandle,
    update: BackendConfigUpdate,
) -> Result<BackendConfigView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BundledBackendState>();
        let _guard = state.lifecycle.lock().unwrap();
        let path = config_file(&app).map_err(|e| e.to_string())?;
        let mut settings = load(&path).map_err(|e| e.to_string())?;
        apply(&mut settings, update.values).map_err(|e| e.to_string())?;
        persist(&path, &settings).map_err(|e| e.to_string())?;
        view(&app).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn bundled_backend_get_auto_start(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        config_file(&app)
            .and_then(|p| load(&p))
            .map(|s| s.auto_start)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn bundled_backend_set_auto_start(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BundledBackendState>();
        let _guard = state.lifecycle.lock().unwrap();
        let path = config_file(&app).map_err(|e| e.to_string())?;
        let mut settings = load(&path).map_err(|e| e.to_string())?;
        settings.auto_start = enabled;
        persist(&path, &settings).map_err(|e| e.to_string())?;
        Ok(enabled)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn prepare_local_backend_tls(app: AppHandle, backend_url: String) -> Result<(), String> {
    let _ = (app, backend_url);
    // Embedded loopback backend uses HTTP. Remote TLS remains handled by
    // configure_backend_connection_tls and the per-profile certificate store.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_port_directory_and_supported_fields() {
        let mut settings = Settings::default();
        assert!(apply(
            &mut settings,
            BTreeMap::from([("serverPort".into(), "65536".into())])
        )
        .is_err());
        assert!(apply(
            &mut settings,
            BTreeMap::from([("dataDirectory".into(), "relative".into())])
        )
        .is_err());
        assert!(apply(
            &mut settings,
            BTreeMap::from([("aiApiKey".into(), "value".into())])
        )
        .is_err());
        apply(
            &mut settings,
            BTreeMap::from([("serverPort".into(), "0".into())]),
        )
        .unwrap();
        assert_eq!(settings.server_port, 0);
    }
    #[test]
    fn settings_persist_without_losing_startup_preference() {
        let path = std::env::temp_dir().join(format!(
            "shellpilot-preview-settings-{}.json",
            std::process::id()
        ));
        let mut settings = Settings {
            auto_start: false,
            ..Default::default()
        };
        persist(&path, &settings).unwrap();
        apply(
            &mut settings,
            BTreeMap::from([("serverPort".into(), "8991".into())]),
        )
        .unwrap();
        persist(&path, &settings).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.server_port, 8991);
        assert!(!loaded.auto_start);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("json.bak"));
    }
    #[test]
    fn attachment_settings_validate_ranges_and_read_legacy_preview_config() {
        let legacy: Settings =
            serde_json::from_str(r#"{"serverPort":0,"autoStart":false}"#).unwrap();
        assert!(legacy.file_storage_enabled);
        assert_eq!(legacy.max_storage_mib, 1024);
        assert_eq!(legacy.file_retention_days, 0);
        assert!(!legacy.auto_start);
        let mut settings = legacy;
        for (field, value) in [
            ("maxStorageMiB", "19"),
            ("fileRetentionDays", "3651"),
            ("downloadLinkMinutes", "0"),
            ("fileStorageEnabled", "maybe"),
        ] {
            assert!(apply(
                &mut settings,
                BTreeMap::from([(field.into(), value.into())])
            )
            .is_err());
        }
        apply(
            &mut settings,
            BTreeMap::from([
                ("maxStorageMiB".into(), "2048".into()),
                ("fileRetentionDays".into(), "7".into()),
                ("downloadLinkMinutes".into(), "30".into()),
            ]),
        )
        .unwrap();
        let files = file_settings(&settings);
        assert_eq!(files.max_storage_bytes, 2048 * 1024 * 1024);
        assert_eq!(files.retention.unwrap().as_secs(), 7 * 86400);
        assert_eq!(files.download_ttl.as_secs(), 1800);
        files.validate().unwrap();
    }
}
