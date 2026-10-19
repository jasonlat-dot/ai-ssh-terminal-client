//! Embedded backend running inside the Tauri process, with its own runtime.
//! The desktop owns startup, shutdown and configuration; no JVM or child server.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    thread::{self, JoinHandle},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

const EVENT: &str = "bundled-backend-status-changed";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    revision: u64,
    pub(crate) status: String,
    message: String,
    log_path: Option<String>,
    pub(crate) backend_url: Option<String>,
    engine: &'static str,
}
impl Default for BackendStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            status: "stopped".into(),
            message: "本地工作区尚未初始化".into(),
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
    services: Mutex<Option<(String, std::sync::Arc<shellpilot_server::services::Services>)>>,
    running: Mutex<Option<Running>>,
    status: Mutex<BackendStatus>,
    lifecycle: Mutex<()>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    data_directory: Option<PathBuf>,
    auto_start: bool,
    file_storage_enabled: bool,
    max_storage_mib: u64,
    file_retention_days: u64,
    log_level: shellpilot_server::diagnostics::Level,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            data_directory: None,
            auto_start: true,
            file_storage_enabled: true,
            max_storage_mib: 1024,
            file_retention_days: 0,
            log_level: shellpilot_server::diagnostics::Level::Info,
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
    trace_log_directory: String,
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
    Ok(home(app)?.join("workspace.json"))
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
    let running = state.running.lock().unwrap().take();
    state.services.lock().unwrap().take();
    if let Some(running) = running {
        running.cancel.cancel();
        // Stop all readers and transports before dropping the dedicated runtime.
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
    store.diagnostics.configure(root.join("logs/agent"), settings.log_level).map_err(|e|e.to_string())?;
    let instance = uuid::Uuid::new_v4();
    let url = format!("ipc://builtin/{instance}");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    let file_settings = file_settings(&settings);
    let services = runtime.block_on(async {
        shellpilot_server::services::Services::native(store, file_settings, instance)
    });
    *app.state::<BundledBackendState>().services.lock().unwrap() =
        Some((url.clone(), services.clone()));
    let stopping = cancel.clone();
    let state = app.state::<BundledBackendState>();
    append_log(&log, "initializing local workspace (IPC, no HTTP listener)");
    let thread = thread::spawn(move || {
        runtime.block_on(async {
            stopping.cancelled().await;
            services.shutdown().await;
        });
        append_log(&log, "local workspace stopped");
    });
    *state.running.lock().unwrap() = Some(Running { cancel, thread });
    Ok(publish(app, "running", "本地工作区已就绪", Some(url)))
}
/// IPC requests retain the exact running instance; restart cannot route old sessions to a new one.
pub fn services(
    app: &AppHandle,
    endpoint: &str,
) -> Result<std::sync::Arc<shellpilot_server::services::Services>, String> {
    app.state::<BundledBackendState>()
        .services
        .lock()
        .unwrap()
        .clone()
        .filter(|(identity, services)| identity.as_str() == endpoint && !services.stop.is_cancelled())
        .map(|(_, services)| services)
        .ok_or_else(|| "本地工作区尚未初始化或已停止".into())
}
fn start_locked(app: &AppHandle) -> BackendStatus {
    publish(app, "starting", "正在初始化本地工作区…", None);
    match start_inner(app) {
        Ok(status) => status,
        Err(error) => publish(app, "failed", error, None),
    }
}
pub fn start_in_background(app: AppHandle) {
    publish(&app, "starting", "正在初始化本地工作区…", None);
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
                    "自动初始化已关闭，可手动打开本地工作区",
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
    publish(app, "stopped", "本地工作区已停止", None);
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
        ("dataDirectory", data.to_string_lossy().into_owned()),
        (
            "fileStorageEnabled",
            settings.file_storage_enabled.to_string(),
        ),
        ("maxStorageMiB", settings.max_storage_mib.to_string()),
        ("logLevel", settings.log_level.text().into()),
        (
            "fileRetentionDays",
            settings.file_retention_days.to_string(),
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
        active_profiles: vec!["embedded".into()],
        values,
        sqlite_file: data
            .join("shellpilot.sqlite3")
            .to_string_lossy()
            .into_owned(),
        upload_directory: data.join("attachments").to_string_lossy().into_owned(),
        log_directory: home(app)?.join("logs").to_string_lossy().into_owned(),
        trace_log_directory: home(app)?.join("logs/agent").to_string_lossy().into_owned(),
        engine: "rust",
    })
}
fn apply(settings: &mut Settings, values: BTreeMap<String, String>) -> io::Result<()> {
    for (key, value) in values {
        match key.as_str() {
            "logLevel" => {
                settings.log_level = shellpilot_server::diagnostics::Level::parse(&value)
                    .ok_or_else(||io::Error::other("日志级别必须为 debug、info、warn 或 error"))?;
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
            _ => return Err(io::Error::other("本地工作区不支持此配置项")),
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
        if let Some((_,services))=state.services.lock().unwrap().as_ref() {
            services.store.diagnostics.set_level(settings.log_level);
        }
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_level_defaults_validates_and_survives_settings_serialization() {
        use shellpilot_server::diagnostics::Level;
        let mut settings:Settings=serde_json::from_str(r#"{"autoStart":false}"#).unwrap();
        assert_eq!(settings.log_level,Level::Info);
        for name in ["debug","info","warn","error"] {
            apply(&mut settings,BTreeMap::from([("logLevel".into(),name.into())])).unwrap();
            let saved:Settings=serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
            assert_eq!(saved.log_level.text(),name);assert!(!saved.auto_start);
        }
        assert!(apply(&mut settings,BTreeMap::from([("logLevel".into(),"trace".into())])).is_err());
    }
    #[test]
    fn validates_directory_and_supported_fields() {
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
            BTreeMap::from([("maxStorageMiB".into(), "1024".into())]),
        )
        .unwrap();
    }
    #[test]
    fn settings_persist_without_losing_startup_preference() {
        let path = std::env::temp_dir().join(format!(
            "shellpilot-settings-{}.json",
            std::process::id()
        ));
        let mut settings = Settings {
            auto_start: false,
            ..Default::default()
        };
        persist(&path, &settings).unwrap();
        apply(
            &mut settings,
            BTreeMap::from([("maxStorageMiB".into(), "2048".into())]),
        )
        .unwrap();
        persist(&path, &settings).unwrap();
        let loaded = load(&path).unwrap();
        assert_eq!(loaded.max_storage_mib, 2048);
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
            ]),
        )
        .unwrap();
        let files = file_settings(&settings);
        assert_eq!(files.max_storage_bytes, 2048 * 1024 * 1024);
        assert_eq!(files.retention.unwrap().as_secs(), 7 * 86400);
        files.validate().unwrap();
    }
}
