use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use crate::backend_process::{self, BackendProcess};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/** 安装包内后端 JAR 的固定资源名称。 */
const BACKEND_JAR_NAME: &str = "ai-ssh-terminal-server-app.jar";

/** 状态改变时的桌面内部事件；与 Java HTTP 健康检查无关。 */
const BACKEND_STATUS_EVENT: &str = "bundled-backend-status-changed";

/** 前端可查询的内置后端运行状态。 */
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    /** 本次客户端运行期间递增；前端据此丢弃晚到的旧查询/命令结果。 */
    revision: u64,
    /** starting、running、failed 或 stopped。 */
    status: String,
    /** 面向用户的状态说明；失败时包含真实启动原因。 */
    message: String,
    /** 当前后端控制台日志的绝对路径。 */
    log_path: Option<String>,
    /** 本次启动实际使用的监听地址，保存新端口但尚未重启时保持原值。 */
    backend_url: Option<String>,
}

/** 单个可编辑配置项的当前值及真实来源文件。 */
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfigValue {
    value: String,
    source_file: String,
    environment_override: Option<String>,
    configured: bool,
    sensitive: bool,
}

/** 设置页读取的内置后端配置快照。 */
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
    /** 默认启用 TLS；供前端生成与后端实际监听协议一致的地址。 */
    ssl_enabled: bool,
}

/** 设置页提交的字段。敏感字段传空字符串时保留现有值。 */
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendConfigUpdate {
    values: BTreeMap<String, String>,
}

/** YAML 中一个字段的原始值、来源文件和可选环境变量。 */
struct LocatedConfigValue {
    raw: String,
    file: PathBuf,
    environment: Option<String>,
}

#[derive(Clone, Copy)]
enum ConfigValueKind {
    Scalar,
    List,
}

#[derive(Clone, Copy)]
enum ConfigValueStyle {
    Text,
    Plain,
}

/** 前端允许编辑的配置白名单，避免客户端提交任意 YAML 路径。 */
struct ConfigField {
    key: &'static str,
    path: &'static [&'static str],
    kind: ConfigValueKind,
    style: ConfigValueStyle,
    sensitive: bool,
}

const CONFIG_FIELDS: &[ConfigField] = &[
    ConfigField { key: "serverPort", path: &["server", "port"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "serverSslAutoGenerate", path: &["server", "ssl", "auto-generate"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "serverHttp2Enabled", path: &["server", "http2", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "serverSslKeyStore", path: &["server", "ssl", "key-store"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "serverSslKeyStoreType", path: &["server", "ssl", "key-store-type"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "serverSslKeyStorePassword", path: &["server", "ssl", "key-store-password"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true },
    ConfigField { key: "serverSslKeyAlias", path: &["server", "ssl", "key-alias"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "dataDirectory", path: &["app", "config", "data-directory"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiBaseUrl", path: &["openai", "ai-api", "base-url"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiApiKey", path: &["openai", "ai-api", "api-key"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true },
    ConfigField { key: "aiCompletionsPath", path: &["openai", "ai-api", "completions-path"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiEmbeddingsPath", path: &["openai", "ai-api", "embeddings-path"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiProxyEnabled", path: &["openai", "ai-api", "proxy", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "aiProxyHost", path: &["openai", "ai-api", "proxy", "host"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiProxyPort", path: &["openai", "ai-api", "proxy", "port"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "aiNonProxyHosts", path: &["openai", "ai-api", "proxy", "non-proxy-hosts"], kind: ConfigValueKind::List, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiModelName", path: &["openai", "chat-model", "model-name"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiReasoningEffort", path: &["openai", "chat-model", "reasoning-effort"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "aiSupportedMediaTypes", path: &["openai", "chat-model", "supported-media-types"], kind: ConfigValueKind::List, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "fileStorageDefaultId", path: &["ai", "file", "storage", "default-id"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "localStorageEnabled", path: &["ai", "file", "storage", "local", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "localStorageId", path: &["ai", "file", "storage", "local", "storage-id"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "localRootDirectory", path: &["ai", "file", "storage", "local", "root-directory"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "localPublicBaseUrl", path: &["ai", "file", "storage", "local", "public-base-url"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "localSigningSecret", path: &["ai", "file", "storage", "local", "signing-secret"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true },
    ConfigField { key: "minioEnabled", path: &["ai", "file", "storage", "minio", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "minioStorageId", path: &["ai", "file", "storage", "minio", "storage-id"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioEndpoint", path: &["ai", "file", "storage", "minio", "endpoint"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioPublicEndpoint", path: &["ai", "file", "storage", "minio", "public-endpoint"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioAccessKey", path: &["ai", "file", "storage", "minio", "access-key"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true },
    ConfigField { key: "minioSecretKey", path: &["ai", "file", "storage", "minio", "secret-key"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true },
    ConfigField { key: "minioBucket", path: &["ai", "file", "storage", "minio", "bucket"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioRegion", path: &["ai", "file", "storage", "minio", "region"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioConnectTimeout", path: &["ai", "file", "storage", "minio", "connect-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioReadTimeout", path: &["ai", "file", "storage", "minio", "read-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioWriteTimeout", path: &["ai", "file", "storage", "minio", "write-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "minioCallTimeout", path: &["ai", "file", "storage", "minio", "call-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "sshProxyEnabled", path: &["ai", "ssh", "http-proxy", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "sshProxyHost", path: &["ai", "ssh", "http-proxy", "host"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "sshProxyPort", path: &["ai", "ssh", "http-proxy", "port"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false },
    ConfigField { key: "sshProxyUsername", path: &["ai", "ssh", "http-proxy", "username"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false },
    ConfigField { key: "sshProxyPassword", path: &["ai", "ssh", "http-proxy", "password"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true },
];

impl Default for BackendStatus {
    fn default() -> Self {
        Self {
            revision: 0,
            status: "stopped".into(),
            message: "内置后端尚未启动".into(),
            log_path: None,
            backend_url: None,
        }
    }
}

/** 保存后端子进程及前端可读取的启动结果。 */
#[derive(Default)]
pub struct BundledBackendState {
    child: Mutex<Option<BackendProcess>>,
    status: Mutex<BackendStatus>,
    stop_requested: AtomicBool,
    /** 后台线程串行执行启动、重启和停止，避免异步命令同时创建多个 Java 进程。 */
    lifecycle: Mutex<()>,
}

/**
 * 在阻塞线程池执行进程和文件操作，异步等待期间不占用窗口线程或异步运行时工作线程。
 * 前端仍收到原有业务结果；线程执行异常通过 invoke 的拒绝路径交给现有错误提示处理。
 */
async fn backend_blocking_task<T: Send + 'static>(
    operation: &'static str,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{operation}后台任务失败：{error}"))?
}

fn starting_status() -> BackendStatus {
    BackendStatus {
        revision: 0,
        status: "starting".into(),
        message: "正在启动内置后端…".into(),
        log_path: None,
        backend_url: None,
    }
}

fn begin_start(app: &AppHandle) {
    app.state::<BundledBackendState>()
        .stop_requested
        .store(false, Ordering::Release);
    set_status(app, starting_status());
}

fn finish_start(app: &AppHandle) -> BackendStatus {
    let status = match start_inner(app) {
        Ok((log_path, backend_url)) => BackendStatus {
            revision: 0,
            status: "running".into(),
            message: "内置后端已启动".into(),
            log_path: Some(log_path.to_string_lossy().into_owned()),
            backend_url: Some(backend_url),
        },
        Err(error) => BackendStatus {
            revision: 0,
            status: "failed".into(),
            message: error.to_string(),
            log_path: error_log_path(app).map(|path| path.to_string_lossy().into_owned()),
            backend_url: None,
        },
    };
    let status = set_status(app, status);
    if status.status == "running" {
        // 只有确实由客户端创建的子进程才安装监视器；开发模式外部 Java 不接管。
        if let Err(error) = monitor_backend_process(app, status.revision) {
            eprintln!("安装内置后端进程监视器失败：{error}");
        }
    }
    status
}

/**
 * 准备外置目录并启动安装包内置的 Java 后端。
 *
 * 用户数据目录与安装目录分离：安装升级只替换只读资源，不覆盖用户修改过的配置和数据。
 *
 * 启动与否由前端的"自动启动内置后端"开关控制：start_in_background 先看开关，
 * 关闭时直接停在 stopped 状态，UI 给出手动启动入口。
 */
pub fn start(app: &AppHandle) -> BackendStatus {
    begin_start(app);
    finish_start(app)
}

/** 在后台线程启动后端，让 WebView 和 React 可以立即绘制启动界面。 */
pub fn start_in_background(app: AppHandle) {
    // 主线程只发布短时状态；偏好读取和日志路径解析同样包含磁盘 IO，全部移入后台。
    begin_start(&app);
    thread::spawn(move || {
        let state = app.state::<BundledBackendState>();
        let Ok(_lifecycle) = state.lifecycle.lock() else {
            set_status(&app, BackendStatus {
                revision: 0,
                status: "failed".into(),
                message: "内置后端操作锁已损坏".into(),
                log_path: None,
                backend_url: None,
            });
            return;
        };

        // 自动启动与手动操作共用生命周期锁；状态查询使用独立短时锁，不等待启动结束。
        if state.stop_requested.load(Ordering::Acquire) {
            return;
        }
        // 手动操作可能在自动启动线程取得锁前已完成；此时保留其结果，不再重复启动。
        if !state.status.lock().map(|status| status.status == "starting").unwrap_or(false) {
            return;
        }
        if !read_auto_start_preference(&app) {
            // 自动启动关闭时，仍可连接用户手工启动的本机后端；提前加载已有公开证书。
            let prepare_trust = || -> Result<(), Box<dyn std::error::Error>> {
                let resource_dir = app.path().resource_dir()?;
                let directory = resolve_backend_home(&resource_dir, &app)?;
                refresh_local_certificate(&app, &directory,
                    read_server_port(&directory).unwrap_or(8889), read_ssl_enabled(&directory)?)?;
                Ok(())
            };
            if let Err(error) = prepare_trust() {
                eprintln!("准备手动启动后端的本机证书信任失败：{error}");
            }
            let status = BackendStatus {
                revision: 0,
                status: "stopped".into(),
                message: "自动启动已关闭。在设置中开启，或在启动页点“启动”。".into(),
                log_path: error_log_path(&app).map(|path| path.to_string_lossy().into_owned()),
                backend_url: None,
            };
            set_status(&app, status);
            return;
        }
        finish_start(&app);
    });
}

/** 执行资源检查、目录准备、Java 进程启动和存活确认。 */
fn start_inner(app: &AppHandle) -> Result<(PathBuf, String), Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    // Installed Tauri resource paths can be verbatim Windows paths. Java needs the
    // equivalent ordinary form for both its executable and the -jar argument.
    let resource_dir = backend_process::launch_path(&resource_dir)?;
    let backend_home = resolve_backend_home(&resource_dir, app)?;
    let backend_home = backend_process::launch_path(&backend_home)?.to_path_buf();
    let server_port = read_server_port(&backend_home).unwrap_or(8889);
    let ssl_enabled = read_ssl_enabled(&backend_home)?;
    let backend_url = format!("https://127.0.0.1:{server_port}");
    let java_executable = bundled_java(&resource_dir);
    let backend_jar = resource_dir.join("backend").join(BACKEND_JAR_NAME);

    // Tauri 开发模式可以继续连接开发者手工启动的后端，不强制要求先生成打包资源。
    if !java_executable.is_file() || !backend_jar.is_file() {
        if cfg!(debug_assertions) {
            eprintln!(
                "未发现内置后端资源，开发模式跳过自动启动。java={} jar={}",
                java_executable.display(),
                backend_jar.display()
            );
            refresh_local_certificate(app, &backend_home, server_port, ssl_enabled)?;
            return Ok((
                backend_home.join("logs").join("backend-console.log"),
                backend_url,
            ));
        }
        return Err(format!(
            "安装包缺少内置后端资源：java={} jar={}",
            java_executable.display(),
            backend_jar.display()
        )
        .into());
    }

    prepare_backend_home(&resource_dir, &backend_home)?;

    // 标准输出与错误输出写入用户目录，后端无法启动时可以直接查看日志定位原因。
    let log_file = open_backend_log(&backend_home.join("logs").join("backend-console.log"))?;
    let error_log = log_file.try_clone()?;
    let config_location = spring_file_directory(&backend_home);

    let config_argument = format!("--spring.config.additional-location={config_location}");
    // Windows 在创建时就绑定独立 Job，强制退出也能回收，不影响外部 Java。
    let mut child = backend_process::spawn(&java_executable, &[
        std::ffi::OsStr::new("--enable-native-access=ALL-UNNAMED"),
        std::ffi::OsStr::new("-jar"),
        backend_jar.as_os_str(),
        std::ffi::OsStr::new(&config_argument),
    ], &backend_home, log_file, error_log).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "无法启动内置后端，java={} jar={}：{error}",
                java_executable.display(),
                backend_jar.display()
            ),
        )
    })?;

    // 等待监听端口就绪后再显示主界面，避免前端首次请求早于 Spring Boot 启动完成。
    let state = app.state::<BundledBackendState>();
    wait_until_ready(
        &mut child,
        server_port,
        Duration::from_secs(60),
        &state.stop_requested,
    )?;

    if state.stop_requested.load(Ordering::Acquire) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "内置后端启动已取消",
        )
        .into());
    }

    // 证书在 Tomcat 监听前生成；在发布 running 前加载公开证书，首个 fetch 即可校验。
    if let Err(error) = refresh_local_certificate(app, &backend_home, server_port, ssl_enabled) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    let mut guard = state.child.lock().map_err(|_| "内置后端进程状态锁已损坏")?;
    *guard = Some(child);
    Ok((backend_home.join("logs").join("backend-console.log"), backend_url))
}

/** 返回当前内置后端状态，供页面在首次渲染和重试后展示准确结果。 */
#[tauri::command]
pub fn bundled_backend_status(state: State<'_, BundledBackendState>) -> BackendStatus {
    state.status.lock().map(|value| value.clone()).unwrap_or_else(|_| BackendStatus {
        revision: 0,
        status: "failed".into(),
        message: "无法读取内置后端状态".into(),
        log_path: None,
        backend_url: None,
    })
}

/**
 * 后台停止旧进程并读取外置配置启动后端。
 * 前端的 await 只等待结果，Rust 必须显式移入阻塞线程池，否则端口等待会冻结窗口消息处理。
 */
#[tauri::command]
pub async fn bundled_backend_restart(app: AppHandle) -> Result<BackendStatus, String> {
    backend_blocking_task("重启内置后端", move || {
        let state = app.state::<BundledBackendState>();
        let _lifecycle = state.lifecycle.lock().map_err(|_| "内置后端操作锁已损坏")?;
        stop(&app);
        Ok(start(&app))
    }).await
}

/**
 * 立即停止内置后端。设置页的"停止内置服务"按钮需要它。
 * 不触碰自动启动偏好——偏好描述的是"客户端启动时是否自动拉起"，
 * 跟"用户现在想停掉"是两件事。
 */
#[tauri::command]
pub async fn bundled_backend_stop(app: AppHandle) -> Result<BackendStatus, String> {
    // 先发送取消信号，后台启动循环才能及时退出；不能等到取得生命周期锁之后才取消。
    app.state::<BundledBackendState>().stop_requested.store(true, Ordering::Release);
    backend_blocking_task("停止内置后端", move || {
        let state = app.state::<BundledBackendState>();
        let _lifecycle = state.lifecycle.lock().map_err(|_| "内置后端操作锁已损坏")?;
        stop(&app);
        let status = BackendStatus {
            revision: 0,
            status: "stopped".into(),
            message: "已停止内置后端".into(),
            log_path: error_log_path(&app).map(|path| path.to_string_lossy().into_owned()),
            backend_url: None,
        };
        Ok(set_status(&app, status))
    }).await
}

/** 读取当前 application.yml 与活动 Profile 中真正生效的桌面配置。 */
#[tauri::command]
pub async fn bundled_backend_config(app: AppHandle) -> Result<BackendConfigView, String> {
    backend_blocking_task("读取内置后端配置", move || {
        load_backend_config(&app).map_err(|error| error.to_string())
    }).await
}

/** 设置页读取当前是否启用了“自动启动内置后端”。 */
#[tauri::command]
pub async fn bundled_backend_get_auto_start(app: AppHandle) -> Result<bool, String> {
    backend_blocking_task("读取自动启动设置", move || Ok(read_auto_start_preference(&app))).await
}

/**
 * 精确更新配置字段。每个字段写回它当前的来源文件，不创建隐藏的高优先级覆盖文件。
 * 写入前保留同目录 .bak 副本，用户手工维护的其他 YAML 内容不会被整体重写。
 */
#[tauri::command]
pub async fn bundled_backend_save_config(app: AppHandle, update: BackendConfigUpdate) -> Result<BackendConfigView, String> {
    backend_blocking_task("保存内置后端配置", move || {
        save_backend_config(&app, update).map_err(|error| error.to_string())?;
        load_backend_config(&app).map_err(|error| error.to_string())
    }).await
}

/** 汇总配置文件、活动 Profile 和设置页支持的字段。 */
fn load_backend_config(app: &AppHandle) -> io::Result<BackendConfigView> {
    let resource_dir = app.path().resource_dir().map_err(io::Error::other)?;
    let backend_home = resolve_backend_home(&resource_dir, app)?;
    let application_file = backend_home.join("application.yml");
    let user_home = app.path().home_dir().map_err(io::Error::other)?;
    let profiles = active_profiles(&application_file)?;
    let files = config_files(&backend_home, &profiles);

    let mut values = BTreeMap::new();
    for field in CONFIG_FIELDS {
        let located = locate_config_field(&files, field)?;
        let effective = effective_config_value(&located.raw, field.kind)
            .replace("${user.home}", &user_home.to_string_lossy());
        values.insert(field.key.to_string(), config_view_value(&located, effective, field.sensitive));
    }

    let data_value = values.get("dataDirectory")
        .map(|value| value.value.clone())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "配置项 dataDirectory 不存在"))?;
    let data_path = PathBuf::from(data_value.trim_matches(['\'', '"']));
    let data_path = if data_path.is_absolute() { data_path } else { backend_home.join(data_path) };
    let resolved_data_directory = data_path.to_string_lossy().into_owned();

    // 页面面向普通用户展示最终路径，不直接暴露 Spring 的属性占位符。
    // 保存时前端会排除派生路径，因此这里只影响显示，不会破坏 YAML 中的动态引用关系。
    for value in values.values_mut().filter(|value| !value.sensitive) {
        value.value = value.value
            .replace("${app.config.data-directory}", &resolved_data_directory)
            .replace("${user.home}", &user_home.to_string_lossy());
    }
    if let Some(value) = values.get_mut("dataDirectory") {
        value.value = resolved_data_directory;
    }

    Ok(BackendConfigView {
        config_directory: backend_home.to_string_lossy().into_owned(),
        application_file: application_file.to_string_lossy().into_owned(),
        active_profiles: profiles,
        values,
        sqlite_file: data_path.join("data").join("ai-ssh-terminal.db").to_string_lossy().into_owned(),
        upload_directory: data_path.join("files").to_string_lossy().into_owned(),
        log_directory: data_path.join("logs").to_string_lossy().into_owned(),
        // 协议固定为 HTTPS。配置页仍可打开以查看证书配置，旧的禁用值在启动时拒绝。
        ssl_enabled: true,
    })
}

/** 校验并保存设置页支持的字段。数据目录迁移由下一次 start 中的既有逻辑完成。 */
fn save_backend_config(app: &AppHandle, update: BackendConfigUpdate) -> io::Result<()> {
    validate_config_update(&update.values)?;

    let resource_dir = app.path().resource_dir().map_err(io::Error::other)?;
    let backend_home = resolve_backend_home(&resource_dir, app)?;
    let application_file = backend_home.join("application.yml");
    let profiles = active_profiles(&application_file)?;
    let files = config_files(&backend_home, &profiles);

    for (key, value) in update.values {
        let Some(field) = CONFIG_FIELDS.iter().find(|field| field.key == key.as_str()) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("不支持的配置项 {key}")));
        };
        // 密钥输入框留空代表不修改，避免页面读取配置时清空已有敏感信息。
        if field.sensitive && value.trim().is_empty() {
            continue;
        }
        update_effective_field(&files, field, value.trim())?;
    }
    Ok(())
}

/** 保存前完成必要的格式校验，业务连接是否正在使用不阻止配置落盘。 */
fn validate_config_update(values: &BTreeMap<String, String>) -> io::Result<()> {
    for key in ["serverPort", "aiProxyPort", "sshProxyPort"] {
        if let Some(value) = values.get(key) {
            let port = value.parse::<u16>().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("{key} 必须是 1 到 65535 之间的整数")))?;
            if port == 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{key} 必须是 1 到 65535 之间的整数")));
            }
        }
    }
    for key in ["aiProxyEnabled", "localStorageEnabled", "minioEnabled", "sshProxyEnabled",
        "serverSslAutoGenerate", "serverHttp2Enabled"] {
        if let Some(value) = values.get(key) {
            if value != "true" && value != "false" {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{key} 只能是 true 或 false")));
            }
        }
    }
    if let Some(value) = values.get("dataDirectory") {
        if !PathBuf::from(value.trim()).is_absolute() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "数据目录必须填写绝对路径"));
        }
    }
    for key in ["aiBaseUrl", "minioEndpoint"] {
        if let Some(value) = values.get(key) {
            if !(value.starts_with("http://") || value.starts_with("https://")) {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("{key} 必须以 http:// 或 https:// 开头")));
            }
        }
    }
    Ok(())
}

/** 返回 application.yml 以及按声明顺序存在的 application-{profile}.yml。 */
fn config_files(backend_home: &Path, profiles: &[String]) -> Vec<PathBuf> {
    let mut files = vec![backend_home.join("application.yml")];
    files.extend(profiles.iter().map(|profile| backend_home.join(format!("application-{profile}.yml"))).filter(|path| path.is_file()));
    files
}

/** 读取 spring.profiles.active；当前模板和常用逗号、行内数组写法均支持。 */
fn active_profiles(application_file: &Path) -> io::Result<Vec<String>> {
    let content = fs::read_to_string(application_file)?;
    let raw = yaml_value(&content, &["spring", "profiles", "active"]).unwrap_or_else(|| "prod".into());
    let value = placeholder_default(&raw).trim_matches(['[', ']', '\'', '"']).to_string();
    let profiles = value.split(',').map(|item| item.trim().trim_matches(['\'', '"']).to_string())
        .filter(|item| !item.is_empty()).collect::<Vec<_>>();
    Ok(if profiles.is_empty() { vec!["prod".into()] } else { profiles })
}

/** 从后加载的 Profile 向前查找，得到 Spring 配置优先级最高的字段。 */
fn locate_config_value(files: &[PathBuf], path: &[&str]) -> io::Result<LocatedConfigValue> {
    for file in files.iter().rev() {
        let content = fs::read_to_string(file)?;
        if let Some(raw) = yaml_value(&content, path) {
            return Ok(LocatedConfigValue { environment: placeholder_environment(&raw), raw, file: file.clone() });
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, format!("配置项 {} 不存在", path.join("."))))
}

/** 按字段类型读取标量或 YAML 列表，并记录仍然生效的环境变量覆盖。 */
fn locate_config_field(files: &[PathBuf], field: &ConfigField) -> io::Result<LocatedConfigValue> {
    for file in files.iter().rev() {
        let content = fs::read_to_string(file)?;
        let raw = match field.kind {
            ConfigValueKind::Scalar => yaml_value(&content, field.path),
            ConfigValueKind::List => yaml_list_value(&content, field.path),
        };
        if let Some(raw) = raw {
            return Ok(LocatedConfigValue {
                environment: active_environment_names(&raw),
                raw,
                file: file.clone(),
            });
        }
    }
    // 已安装版本的 YAML 可能没有新 SSL 字段；读取时只给出默认值，不偷偷修改用户配置。
    let default = match field.key {
        "serverSslAutoGenerate" => "${LOCAL_TLS_AUTO_GENERATE:true}",
        "serverHttp2Enabled" => "${SERVER_HTTP2_ENABLED:true}",
        "serverSslKeyStore" => "${SERVER_SSL_KEY_STORE:file:${app.config.data-directory}/tls/local-backend.p12}",
        "serverSslKeyStoreType" => "PKCS12",
        "serverSslKeyStorePassword" | "serverSslKeyAlias" => "",
        _ => return Err(io::Error::new(io::ErrorKind::NotFound, format!("配置项 {} 不存在", field.path.join(".")))),
    };
    Ok(LocatedConfigValue { raw: default.into(), environment: active_environment_names(default),
        file: files.first().ok_or_else(|| io::Error::other("配置文件列表为空"))?.clone() })
}

/** 读取缩进式 YAML 中指定路径的标量值，不改写注释或其他字段。 */
fn yaml_value(content: &str, path: &[&str]) -> Option<String> {
    let mut parents: Vec<(usize, String)> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') { continue; }
        let indent = line.len() - line.trim_start().len();
        while parents.last().is_some_and(|(parent_indent, _)| *parent_indent >= indent) { parents.pop(); }
        let Some((key, raw_value)) = trimmed.split_once(':') else { continue; };
        let key = key.trim().trim_matches(['\'', '"']);
        let mut current = parents.iter().map(|(_, key)| key.as_str()).collect::<Vec<_>>();
        current.push(key);
        if current == path {
            return Some(strip_inline_comment(raw_value.trim()).to_string());
        }
        if raw_value.trim().is_empty() { parents.push((indent, key.to_string())); }
    }
    None
}

/** 读取块样式 YAML 列表，并使用换行分隔后交给设置页 textarea。 */
fn yaml_list_value(content: &str, path: &[&str]) -> Option<String> {
    let mut parents: Vec<(usize, String)> = Vec::new();
    let mut target_indent = None;
    let mut values = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') { continue; }
        let indent = line.len() - line.trim_start().len();
        if let Some(parent_indent) = target_indent {
            if indent > parent_indent && trimmed.starts_with('-') {
                values.push(strip_inline_comment(trimmed.trim_start_matches('-').trim()).to_string());
                continue;
            }
            if indent <= parent_indent { break; }
        }
        if trimmed.starts_with('-') { continue; }
        while parents.last().is_some_and(|(parent_indent, _)| *parent_indent >= indent) { parents.pop(); }
        let Some((key, raw_value)) = trimmed.split_once(':') else { continue; };
        let key = key.trim().trim_matches(['\'', '"']);
        let mut current = parents.iter().map(|(_, key)| key.as_str()).collect::<Vec<_>>();
        current.push(key);
        if current == path {
            target_indent = Some(indent);
            if !raw_value.trim().is_empty() {
                let inline_value = strip_inline_comment(raw_value.trim());
                // `${ENV:item1,item2}` 必须先作为一个完整占位符保留，不能在这里按逗号切开。
                // 真正的默认值或环境变量值会在 effective_config_value 中解析后再拆成列表。
                if placeholder_environment(inline_value).is_some() {
                    return Some(inline_value.to_string());
                }
                return Some(inline_value.trim_matches(['[', ']']).split(',').map(str::trim).collect::<Vec<_>>().join("\n"));
            }
        }
        if raw_value.trim().is_empty() { parents.push((indent, key.to_string())); }
    }
    target_indent.map(|_| values.join("\n"))
}

/** 将配置值写回当前真正提供该值的文件。 */
fn update_effective_field(files: &[PathBuf], field: &ConfigField, new_value: &str) -> io::Result<()> {
    let located = locate_config_field(files, field)?;
    let content = fs::read_to_string(&located.file)?;
    let updated = match field.kind {
        ConfigValueKind::Scalar => {
            let rendered = render_scalar_value(&located.raw, new_value, field.style);
            replace_yaml_value(&content, field.path, &rendered)
                .or_else(|| insert_yaml_value(&content, field.path, &rendered))
        }
        ConfigValueKind::List => replace_yaml_list(&content, field.path, &located.raw, new_value),
    }.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("无法定位配置项 {}", field.path.join("."))))?;
    if updated != content { write_config_with_backup(&located.file, &updated)?; }
    Ok(())
}

/** 保留原有 ${ENV:default} 结构，仅修改默认值，避免前端保存后破坏环境变量能力。 */
fn render_scalar_value(old_raw: &str, new_value: &str, style: ConfigValueStyle) -> String {
    if let Some(environment) = placeholder_environment(old_raw) {
        return format!("${{{environment}:{new_value}}}");
    }
    match style {
        ConfigValueStyle::Text => yaml_string(new_value),
        ConfigValueStyle::Plain => new_value.to_string(),
    }
}

/** 只替换目标标量所在行，保留原文件顺序、注释和所有未知配置。 */
fn replace_yaml_value(content: &str, path: &[&str], new_value: &str) -> Option<String> {
    let mut parents: Vec<(usize, String)> = Vec::new();
    let mut output = Vec::new();
    let mut replaced = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            output.push(line.to_string());
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        while parents.last().is_some_and(|(parent_indent, _)| *parent_indent >= indent) { parents.pop(); }
        let Some((key_part, raw_value)) = trimmed.split_once(':') else { output.push(line.to_string()); continue; };
        let key = key_part.trim().trim_matches(['\'', '"']);
        let mut current = parents.iter().map(|(_, key)| key.as_str()).collect::<Vec<_>>();
        current.push(key);
        if current == path {
            let comment = inline_comment(raw_value).unwrap_or_default();
            output.push(format!("{}{}: {}{}", " ".repeat(indent), key_part.trim(), new_value, comment));
            replaced = true;
        } else {
            output.push(line.to_string());
        }
        if raw_value.trim().is_empty() { parents.push((indent, key.to_string())); }
    }
    replaced.then(|| {
        let mut value = output.join(if content.contains("\r\n") { "\r\n" } else { "\n" });
        if content.ends_with('\n') { value.push('\n'); }
        value
    })
}

/** 替换块样式 YAML 列表；同序号原值有环境变量时继续保留该变量名称。 */
fn replace_yaml_list(content: &str, path: &[&str], old_raw: &str, new_value: &str) -> Option<String> {
    let old_items = old_raw.lines().collect::<Vec<_>>();
    let new_items = new_value.lines().map(str::trim).filter(|item| !item.is_empty()).collect::<Vec<_>>();
    let mut parents: Vec<(usize, String)> = Vec::new();
    let mut output = Vec::new();
    let mut target_indent = None;
    let mut replaced = false;

    for line in content.lines() {
        let trimmed = line.trim();
        let indent = line.len() - line.trim_start().len();
        if let Some(parent_indent) = target_indent {
            if indent > parent_indent && trimmed.starts_with('-') { continue; }
            target_indent = None;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            output.push(line.to_string());
            continue;
        }
        while parents.last().is_some_and(|(parent_indent, _)| *parent_indent >= indent) { parents.pop(); }
        let Some((key_part, raw_value)) = trimmed.split_once(':') else { output.push(line.to_string()); continue; };
        let key = key_part.trim().trim_matches(['\'', '"']);
        let mut current = parents.iter().map(|(_, key)| key.as_str()).collect::<Vec<_>>();
        current.push(key);
        if current == path {
            if !raw_value.trim().is_empty() {
                // 行内列表继续保持行内格式；环境变量写法只替换冒号后的默认列表。
                let joined = new_items.join(",");
                let rendered = placeholder_environment(old_raw)
                    .map(|environment| format!("${{{environment}:{joined}}}"))
                    .unwrap_or_else(|| format!("[{}]", new_items.iter().map(|item| yaml_string(item)).collect::<Vec<_>>().join(", ")));
                let comment = inline_comment(raw_value).unwrap_or_default();
                output.push(format!("{}{}: {}{}", " ".repeat(indent), key_part.trim(), rendered, comment));
            } else {
                output.push(line.to_string());
                for (index, item) in new_items.iter().enumerate() {
                    let rendered = old_items.get(index)
                        .and_then(|old| placeholder_environment(old))
                        .map(|environment| format!("${{{environment}:{item}}}"))
                        .unwrap_or_else(|| yaml_string(item));
                    output.push(format!("{}- {rendered}", " ".repeat(indent + 2)));
                }
                target_indent = Some(indent);
            }
            replaced = true;
        } else {
            output.push(line.to_string());
        }
        if raw_value.trim().is_empty() { parents.push((indent, key.to_string())); }
    }
    replaced.then(|| finish_yaml_output(content, output))
}

fn finish_yaml_output(content: &str, output: Vec<String>) -> String {
    let mut value = output.join(if content.contains("\r\n") { "\r\n" } else { "\n" });
    if content.ends_with('\n') { value.push('\n'); }
    value
}

/** 先保存 .bak 和临时文件，再用新内容替换目标文件。 */
fn write_config_with_backup(path: &Path, content: &str) -> io::Result<()> {
    let file_name = path.file_name().and_then(|value| value.to_str()).ok_or_else(|| io::Error::other("配置文件名无效"))?;
    let backup = path.with_file_name(format!("{file_name}.bak"));
    let temporary = path.with_file_name(format!("{file_name}.tmp"));
    fs::copy(path, &backup)?;
    fs::write(&temporary, content)?;
    fs::remove_file(path)?;
    if let Err(error) = fs::rename(&temporary, path) {
        // Windows 上替换失败时立即恢复备份，避免配置文件只剩临时文件。
        let _ = fs::copy(&backup, path);
        return Err(error);
    }
    Ok(())
}

fn strip_inline_comment(value: &str) -> &str { value.split_once(" #").map(|(value, _)| value.trim_end()).unwrap_or(value) }
fn inline_comment(value: &str) -> Option<String> { value.find(" #").map(|index| value[index..].to_string()) }
fn yaml_string(value: &str) -> String { format!("'{}'", value.replace('\'', "''")) }
fn display_file_name(path: &Path) -> String { path.file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned()) }

fn placeholder_environment(raw: &str) -> Option<String> {
    let value = raw.trim().trim_matches(['\'', '"']);
    let body = value.strip_prefix("${")?.strip_suffix('}')?;
    Some(body.split_once(':')?.0.trim().to_string())
}

fn placeholder_default(raw: &str) -> String {
    let value = raw.trim().trim_matches(['\'', '"']);
    let Some(body) = value.strip_prefix("${").and_then(|value| value.strip_suffix('}')) else { return value.to_string(); };
    body.split_once(':').map(|(_, fallback)| fallback.to_string()).unwrap_or_default()
}

fn effective_scalar(raw: &str, environment: Option<&str>) -> String {
    environment.and_then(|name| std::env::var(name).ok()).unwrap_or_else(|| placeholder_default(raw))
}

fn active_environment_names(raw: &str) -> Option<String> {
    let names = raw.lines().filter_map(placeholder_environment)
        .filter(|name| std::env::var_os(name).is_some()).collect::<Vec<_>>();
    (!names.is_empty()).then(|| names.join(", "))
}

fn effective_config_value(raw: &str, kind: ConfigValueKind) -> String {
    match kind {
        ConfigValueKind::Scalar => effective_scalar(raw, placeholder_environment(raw).as_deref()),
        ConfigValueKind::List => raw.lines()
            // 先解析 `${ENV:默认值}`，环境变量和默认值都可能是逗号分隔列表。
            .map(|item| effective_scalar(item, placeholder_environment(item).as_deref()))
            .flat_map(|item| item.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn config_view_value(value: &LocatedConfigValue, effective: String, sensitive: bool) -> BackendConfigValue {
    BackendConfigValue {
        configured: !effective.trim().is_empty(),
        value: if sensitive { String::new() } else { effective },
        source_file: display_file_name(&value.file),
        environment_override: value.environment.clone(),
        sensitive,
    }
}

/**
 * 唯一状态发布入口：先保存快照，再向前端发送事件，并返回带真实版本号的结果。
 *
 * 完全相同的状态不重复发送。事件发送在释放状态锁之后进行，避免 IPC 占用共享锁；
 * 即使两条通知交错到达，前端仍可通过 revision 判断新旧。页面尚未创建时没有监听者
 * 也没关系，首次订阅后的一次快照读取会补齐当前状态。
 */
fn set_status(app: &AppHandle, mut status: BackendStatus) -> BackendStatus {
    let state = app.state::<BundledBackendState>();
    let published = match state.status.lock() {
        Ok(mut current) => {
            if current.status == status.status && current.message == status.message
                && current.log_path == status.log_path && current.backend_url == status.backend_url {
                return current.clone();
            }
            status.revision = current.revision + 1;
            *current = status.clone();
            status
        }
        Err(_) => {
            eprintln!("无法发布内置后端状态：状态锁已损坏");
            return status;
        }
    };
    if let Err(error) = app.emit(BACKEND_STATUS_EVENT, &published) {
        // 通知错误不撤销真实进程状态，也不能因为界面通知失败而导致客户端崩溃。
        eprintln!("发送内置后端状态通知失败：{error}");
    }
    published
}

/**
 * 监测客户端拥有的 Java 子进程。revision 标识本轮运行，PID 仅用于额外核对身份。
 *
 * Windows 复制独立进程句柄，在后台线程等待系统的退出信号，不使用定时器或 HTTP。
 * 独立句柄由 OwnedHandle 自动关闭；等待过程中不持有任何状态/生命周期锁，因此
 * 手动停止、重启及窗口消息处理不会被阻塞。非 Windows 保留低频本地存活检查，
 * 不产生 WebView IPC 请求，不监测用户自己启动的远程/IDEA Java。
 */
fn monitor_backend_process(app: &AppHandle, revision: u64) -> io::Result<()> {
    let state = app.state::<BundledBackendState>();
    let guard = state.child.lock().map_err(|_| io::Error::other("后端进程锁已损坏"))?;
    let Some(child) = guard.as_ref() else { return Ok(()); };
    let process_id = child.id();

    #[cfg(target_os = "windows")]
    let process_handle = {
        use std::os::windows::io::AsHandle;
        child.as_handle().try_clone_to_owned()?
    };
    drop(guard);

    let app = app.clone();
    thread::Builder::new().name("bundled-backend-exit".into()).spawn(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
            use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
            // SAFETY：OwnedHandle 在等待结束前保持存活；它是复制自 Child 的有效进程句柄。
            // 阻塞只发生在专用后台线程，原 Child 仍由停止逻辑持有并可随时 kill/wait。
            let result = unsafe { WaitForSingleObject(HANDLE(process_handle.as_raw_handle()), INFINITE) };
            if result == WAIT_OBJECT_0 {
                check_backend_process_exit(&app, revision, process_id);
            } else {
                eprintln!("等待内置后端退出失败：{}", io::Error::last_os_error());
            }
        }
        #[cfg(not(target_os = "windows"))]
        loop {
            if check_backend_process_exit(&app, revision, process_id) { break; }
            thread::sleep(Duration::from_secs(2));
        }
    })?;
    Ok(())
}

/**
 * 核实退出后发布 failed；返回 true 表示本轮监视已经结束。
 *
 * 先取得生命周期锁，避免旧进程的退出通知把刚完成重启的新进程标成失败。
 * 主动 stop/restart 已设置取消标记，不属于意外退出，留给对应命令发布最终状态。
 * try_wait 不阻塞；不会持着锁等待仍在运行的进程退出。
 */
fn check_backend_process_exit(app: &AppHandle, revision: u64, process_id: u32) -> bool {
    let state = app.state::<BundledBackendState>();
    let Ok(_lifecycle) = state.lifecycle.lock() else { return true; };
    if state.stop_requested.load(Ordering::Acquire) { return true; }
    let previous = match state.status.lock() {
        Ok(current) if current.revision == revision && current.status == "running" => current.clone(),
        _ => return true,
    };
    let Ok(mut guard) = state.child.lock() else { return true; };
    let Some(child) = guard.as_mut().filter(|child| child.id() == process_id) else { return true; };
    match child.try_wait() {
        Ok(Some(exit)) => {
            // 清掉已经退出的句柄，避免后续证书逻辑仍把它当作客户端拥有的活进程。
            guard.take();
            drop(guard);
            set_status(app, BackendStatus {
                status: "failed".into(),
                message: format!("内置后端意外退出：{exit}；请查看日志目录"),
                // 保留该进程的真实地址与日志位置，不能用尚未生效的新配置覆盖。
                ..previous
            });
            true
        }
        Ok(None) => false,
        Err(error) => {
            eprintln!("读取内置后端退出状态失败：{error}");
            true
        }
    }
}

/** 客户端正常退出时终止它启动的 Java 后端，避免后台残留进程继续占用端口。 */
pub fn stop(app_handle: &AppHandle) {
    let state = app_handle.state::<BundledBackendState>();
    state.stop_requested.store(true, Ordering::Release);
    // 仅取出进程句柄时持锁；kill/wait 的耗时不应延长共享状态锁占用。
    let child = match state.child.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => return,
    };
    let Some(mut child) = child else {
        return;
    };

    let _ = child.kill();
    let _ = child.wait();
}

/**
 * 确定统一后端数据根目录。
 *
 * 首次启动默认使用 `${user.home}/.ai-ssh-terminal`。用户在 application.yml 中修改
 * `app.config.data-directory` 后，下一次启动会复制现有数据到新目录并记录新位置。
 * 路径记录只负责解决“配置文件搬走后下次从哪里找到它”的引导问题，不保存业务数据。
 */
fn resolve_backend_home(resource_dir: &Path, app: &AppHandle) -> io::Result<PathBuf> {
    let launcher_directory = app
        .path()
        .app_local_data_dir()
        .map_err(io::Error::other)?;
    let user_home = app.path().home_dir().map_err(io::Error::other)?;
    let default_home = user_home.join(".ai-ssh-terminal");
    let location_file = launcher_directory.join("backend-location.txt");

    fs::create_dir_all(&launcher_directory)?;
    let current_home = fs::read_to_string(&location_file)
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(default_home);

    prepare_backend_home(resource_dir, &current_home)?;
    let configured_home = read_data_directory(&current_home.join("application.yml"), &user_home)
        .unwrap_or_else(|| current_home.clone());

    if configured_home != current_home {
        // 保留原目录作为可恢复副本，只把当前内容合并复制到用户指定的新根目录。
        copy_directory(&current_home, &configured_home)?;
        prepare_backend_home(resource_dir, &configured_home)?;
    }

    fs::write(location_file, configured_home.to_string_lossy().as_bytes())?;
    Ok(configured_home)
}

/** 从 application.yml 读取统一数据根目录，支持绝对路径和默认占位符写法。 */
fn read_data_directory(application_yml: &Path, user_home: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(application_yml).ok()?;
    let configured = content
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .find_map(|line| line.strip_prefix("data-directory:").map(str::trim))?;

    let default_home = user_home.join(".ai-ssh-terminal");
    if configured.contains("AI_SSH_TERMINAL_HOME") {
        return std::env::var_os("AI_SSH_TERMINAL_HOME")
            .map(PathBuf::from)
            .or(Some(default_home));
    }

    let expanded = configured
        .trim_matches(['\'', '"'])
        .replace("${user.home}", &user_home.to_string_lossy());
    let path = PathBuf::from(expanded);
    Some(if path.is_absolute() {
        path
    } else {
        application_yml.parent()?.join(path)
    })
}

/** 递归合并复制目录内容；切换根目录时不删除旧数据，避免配置错误造成不可恢复的丢失。 */
fn copy_directory(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path)?;
        }
    }
    Ok(())
}

/** 尽最大可能算出日志路径，让前端在启动早期失败时也能给出排查位置。 */
fn error_log_path(app: &AppHandle) -> Option<PathBuf> {
    let location_file = app.path().app_local_data_dir().ok()?.join("backend-location.txt");
    let backend_home = fs::read_to_string(location_file)
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| app.path().home_dir().ok().map(|path| path.join(".ai-ssh-terminal")))?;
    Some(backend_home.join("logs").join("backend-console.log"))
}

/**
 * 客户端设置“自动启动内置后端”开关的持久化文件。
 *
 * 文件不存在或值不是 "false" 时一律视为 true（默认开启，与新用户预期一致）。
 * 与 application.yml 无关，这个偏好只影响桌面壳是否自动拉 Java 进程。
 */
fn auto_start_preference_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("auto-start.txt"))
}

fn read_auto_start_preference(app: &AppHandle) -> bool {
    let Some(path) = auto_start_preference_path(app) else { return true; };
    let Ok(raw) = fs::read_to_string(&path) else { return true; };
    let stripped = raw.strip_prefix('\u{FEFF}').unwrap_or(&raw);
    !matches!(stripped.trim().to_ascii_lowercase().as_str(), "false" | "0" | "off" | "no")
}

/**
 * 仅持久化自动启动偏好，不在这里拉起或停止 Java。
 * - 这个开关描述的是“客户端启动时是否自动拉起后端”，生效时机是下一次打开客户端。
 * - 当前 Java 进程跟偏好是独立的：用户在跑着 Java 时关掉开关 ≠ 让他立刻停；
 *   真正要停请点设置页的“停止内置服务”按钮。
 */
#[tauri::command]
pub async fn bundled_backend_set_auto_start(app: AppHandle, enabled: bool) -> Result<bool, String> {
    backend_blocking_task("保存自动启动设置", move || {
        let Some(path) = auto_start_preference_path(&app) else {
            return Err("无法获取客户端数据目录".into());
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建客户端数据目录失败：{error}"))?;
        }
        fs::write(&path, if enabled { &b"true"[..] } else { &b"false"[..] })
            .map_err(|error| format!("保存自动启动设置失败：{error}"))?;
        Ok(enabled)
    }).await
}

/**
 * 创建数据、上传和日志目录，并按“application.yml 是否存在”决定是否初始化默认配置。
 * application.yml 存在时不复制任何 YAML，允许用户自由使用 dev、sit 或自定义 profile。
 */
fn prepare_backend_home(resource_dir: &Path, backend_home: &Path) -> io::Result<()> {
    fs::create_dir_all(backend_home.join("data"))?;
    fs::create_dir_all(backend_home.join("uploads"))?;
    fs::create_dir_all(backend_home.join("logs"))?;

    let application_yml = backend_home.join("application.yml");
    if application_yml.exists() {
        return Ok(());
    }

    let defaults = resource_dir.join("backend").join("default-config");
    // application.yml 是“初始化完成”标记，因此最后复制；中途失败时下次启动仍会重试。
    copy_required(
        &defaults.join("application-prod.yml"),
        &backend_home.join("application-prod.yml"),
    )?;
    copy_required(&defaults.join("application.yml"), &application_yml)?;
    Ok(())
}

/** 复制首次启动所需的配置模板；资源缺失时返回包含具体路径的错误。 */
fn copy_required(source: &Path, target: &Path) -> io::Result<()> {
    if !source.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("安装包缺少默认配置模板：{}", source.display()),
        ));
    }
    fs::copy(source, target)?;
    Ok(())
}

/** 以追加模式保存启动日志，重启客户端不会丢失上一轮后端启动失败信息。 */
fn open_backend_log(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/**
 * 读取 application.yml 顶层 server.port。
 * 同时识别 8888 和 ${SERVER_PORT:8888}，解析失败时由调用方使用默认端口。
 */
fn read_server_port(backend_home: &Path) -> Option<u16> {
    if let Ok(port) = std::env::var("SERVER_PORT") {
        return port.parse().ok();
    }
    // 与设置页使用同一套 Profile 优先级，避免端口写在 application-prod.yml 时等待错误端口。
    let application_file = backend_home.join("application.yml");
    let profiles = active_profiles(&application_file).ok()?;
    let files = config_files(backend_home, &profiles);
    let port = locate_config_value(&files, &["server", "port"]).ok()?;
    effective_scalar(&port.raw, port.environment.as_deref()).parse::<u16>().ok()
}

/**
 * 在最深的现有 YAML 映射内补充新字段，避免旧安装包缺少 SSL 字段时保存失败。
 * 只插入白名单中的缩进式标量路径，保留既有注释、换行及其他字段；不重写整份 YAML。
 * @param content 原始配置文本
 * @param path 已由 CONFIG_FIELDS 限定的配置路径
 * @param new_value 已完成 YAML 转义的值
 */
fn insert_yaml_value(content: &str, path: &[&str], new_value: &str) -> Option<String> {
    let mut parents: Vec<(usize, String)> = Vec::new();
    let lines: Vec<_> = content.lines().collect();
    let mut deepest = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') { continue; }
        let indent = line.len() - line.trim_start().len();
        while parents.last().is_some_and(|(level, _)| *level >= indent) { parents.pop(); }
        let Some((key, raw)) = trimmed.split_once(':') else { continue; };
        let key = key.trim().trim_matches(['\'', '"']);
        let mut current = parents.iter().map(|(_, name)| name.as_str()).collect::<Vec<_>>();
        current.push(key);
        let mapping = strip_inline_comment(raw.trim()).is_empty();
        if current.len() < path.len() && current == path[..current.len()] {
            if !mapping { return None; } // 不给行内映射或标量节点创建重复的父键。
            deepest = Some((current.len(), index, indent));
        }
        if mapping { parents.push((indent, key.into())); }
    }
    let (depth, insertion, base_indent) = match deepest {
        Some((depth, index, indent)) => {
            let end = ((index + 1)..lines.len()).find(|position| {
                let line = lines[*position];
                !line.trim().is_empty() && !line.trim_start().starts_with('#')
                    && line.len() - line.trim_start().len() <= indent
            }).unwrap_or(lines.len());
            (depth, end, indent + 2)
        }
        None => (0, lines.len(), 0),
    };
    let mut output = lines[..insertion].iter().map(|line| line.to_string()).collect::<Vec<_>>();
    for (offset, key) in path[depth..].iter().enumerate() {
        let value = if depth + offset + 1 == path.len() { format!(" {new_value}") } else { String::new() };
        output.push(format!("{}{key}:{value}", " ".repeat(base_indent + offset * 2)));
    }
    output.extend(lines[insertion..].iter().map(|line| line.to_string()));
    let separator = if content.contains("\r\n") { "\r\n" } else { "\n" };
    Some(format!("{}{separator}", output.join(separator)))
}

/** 启动前检查旧配置；协议固定为 HTTPS，false 必须显式修正，不能推导出 HTTP 地址。 */
fn read_ssl_enabled(backend_home: &Path) -> io::Result<bool> {
    let raw = if let Ok(value) = std::env::var("SERVER_SSL_ENABLED") {
        value
    } else {
        let profiles = active_profiles(&backend_home.join("application.yml"))?;
        match locate_config_value(&config_files(backend_home, &profiles), &["server", "ssl", "enabled"]) {
            Ok(value) => effective_scalar(&value.raw, value.environment.as_deref()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => "true".into(),
            Err(error) => return Err(error),
        }
    };
    match raw.to_ascii_lowercase().as_str() {
        "true" => Ok(true),
        "false" => Err(io::Error::other("Java 后端必须使用 HTTPS；请将旧配置 server.ssl.enabled 改为 true，并移除 SERVER_SSL_ENABLED=false 环境变量")),
        _ => Err(io::Error::other("server.ssl.enabled 必须为 true 或 false")),
    }
}

/** 使用与配置页一致的真实数据根目录，避免配置目录和数据目录分离时读错证书。 */
fn refresh_local_certificate(app: &AppHandle, backend_home: &Path, port: u16, enabled: bool) -> io::Result<()> {
    let directory = read_tls_data_directory(app, backend_home)?;
    // 选择自定义证书或关闭自动生成后，旧的 local-backend.crt 不再代表运行中的后端。
    let managed = enabled && uses_managed_tls_store(backend_home, &directory)?;
    crate::local_backend_tls::refresh(app, &directory, port, managed)
}

/** 仅自动管理模式且 key-store 仍指向默认文件时，才能使用内置证书的固定信任。 */
fn uses_managed_tls_store(backend_home: &Path, directory: &Path) -> io::Result<bool> {
    let profiles = active_profiles(&backend_home.join("application.yml"))?;
    let files = config_files(backend_home, &profiles);
    let value = |path: &[&str]| -> io::Result<Option<String>> {
        match locate_config_value(&files, path) {
            Ok(found) => Ok(Some(effective_scalar(&found.raw, found.environment.as_deref()))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    };
    if std::env::var("LOCAL_TLS_AUTO_GENERATE").ok()
        .or(value(&["server", "ssl", "auto-generate"])?).is_some_and(|value| value.trim() == "false") {
        return Ok(false);
    }
    if value(&["server", "ssl", "certificate"])?.is_some_and(|value| !value.trim().is_empty())
        || value(&["server", "ssl", "bundle"])?.is_some_and(|value| !value.trim().is_empty()) {
        return Ok(false);
    }
    let Some(store) = std::env::var("SERVER_SSL_KEY_STORE").ok().or(value(&["server", "ssl", "key-store"])?) else {
        return Ok(true); // 兼容旧 YAML：后端处理器默认使用统一数据目录下的证书。
    };
    if store.trim().is_empty() { return Ok(true); }
    let store = store.replace("${app.config.data-directory}", &directory.to_string_lossy())
        .replace('\\', "/");
    let default = directory.join("tls/local-backend.p12").to_string_lossy().replace('\\', "/");
    let configured = store.strip_prefix("file:").unwrap_or(&store);
    // Windows file:/C:/... 与 C:/... 表示相同的本机文件；不下载 classpath/网络资源。
    let configured = if cfg!(windows) && configured.starts_with('/') && configured.as_bytes().get(2) == Some(&b':') {
        &configured[1..]
    } else { configured };
    Ok(if cfg!(windows) { configured.eq_ignore_ascii_case(&default) } else { configured == default })
}

/** 只读取配置来定位证书，不启动进程、不复制/迁移数据，也不修改 YAML。 */
fn read_tls_data_directory(app: &AppHandle, backend_home: &Path) -> io::Result<PathBuf> {
    // 不复用整份设置页快照：证书初始化不应依赖 AI 密钥等不相关配置项是否齐全。
    let user_home = app.path().home_dir().map_err(io::Error::other)?;
    let profiles = active_profiles(&backend_home.join("application.yml"))?;
    let raw = match locate_config_value(&config_files(backend_home, &profiles), &["app", "config", "data-directory"]) {
        Ok(value) => effective_scalar(&value.raw, value.environment.as_deref())
            .replace("${user.home}", &user_home.to_string_lossy()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => user_home.join(".ai-ssh-terminal").to_string_lossy().into_owned(),
        Err(error) => return Err(error),
    };
    let directory = PathBuf::from(raw);
    let directory = if directory.is_absolute() { directory } else { backend_home.join(directory) };
    Ok(directory)
}

/**
 * 在连接 IDEA 等手工启动的本机 HTTPS 后端前加载公开证书。
 *
 * @param app 桌面应用句柄，用于读取用户目录和固定信任状态
 * @param backend_url 用户实际选择的根地址；只处理 HTTPS 回环地址，绝不自动信任远程证书
 * @return 成功准备，或可展示的文件/证书读取错误；没有默认证书时仍保持系统正常 TLS 校验
 */
#[tauri::command]
pub async fn prepare_local_backend_tls(app: AppHandle, backend_url: String) -> Result<(), String> {
    backend_blocking_task("准备本机后端证书", move || {
        prepare_external_local_certificate(&app, &backend_url).map_err(|error| error.to_string())
    }).await
}

/** 外部连接不经过 start_inner，因此必须按连接目标加载证书，不能依赖内置后端启动时机。 */
fn prepare_external_local_certificate(app: &AppHandle, raw_url: &str) -> io::Result<()> {
    let url = reqwest::Url::parse(raw_url).map_err(io::Error::other)?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !url.username().is_empty() || url.password().is_some()
    {
        // HTTP 和远程域名/IP 不读取本机证书，更不会通过此接口获得证书错误豁免。
        return Ok(());
    }
    let port = url.port_or_known_default().ok_or_else(|| io::Error::other("后端 HTTPS 端口无效"))?;
    let state = app.state::<BundledBackendState>();
    let owned = state.child.lock().map_err(|_| io::Error::other("后端进程锁已损坏"))?.is_some();
    let owned_port = state.status.lock().map_err(|_| io::Error::other("后端状态锁已损坏"))?
        .backend_url.as_deref().and_then(|raw| reqwest::Url::parse(raw).ok())
        .and_then(|url| url.port_or_known_default());
    if owned && owned_port == Some(port) {
        // 真正内置运行的进程已按其真实数据目录加载证书，不用源码默认目录覆盖它。
        return Ok(());
    }

    let user_home = app.path().home_dir().map_err(io::Error::other)?;
    let mut directories = Vec::new();
    #[cfg(debug_assertions)]
    {
        // Tauri dev 与 IDEA 共用源码工作区，但 IDEA 使用源码 YAML，而非安装版的外置 YAML。
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ai-ssh-terminal-server/ai-ssh-terminal-server-app/src/main/resources");
        if resources.join("application.yml").is_file() {
            let directory = read_tls_data_directory(app, &resources)?;
            if !uses_managed_tls_store(&resources, &directory)? {
                return crate::local_backend_tls::refresh(app, &directory, port, false);
            }
            directories.push(directory);
        }
    }
    if let Some(directory) = std::env::var_os("AI_SSH_TERMINAL_HOME") {
        directories.push(PathBuf::from(directory));
    }
    directories.push(user_home.join(".ai-ssh-terminal"));
    // 也兼容手工使用安装版外置配置启动的 Java；只读取引导文件，不能触发目录复制。
    let location = app.path().app_local_data_dir().map_err(io::Error::other)?.join("backend-location.txt");
    if let Ok(value) = fs::read_to_string(location) {
        let directory = PathBuf::from(value.trim());
        if directory.join("application.yml").is_file() {
            directories.push(read_tls_data_directory(app, &directory)?);
        }
    }
    if let Some(directory) = directories.into_iter().find(|directory| directory.join("tls/local-backend.crt").is_file()) {
        crate::local_backend_tls::refresh(app, &directory, port, true)?;
    }
    Ok(())
}

/** 等待 Spring Boot 开始监听；进程提前退出或超时会阻止客户端带着不可用后端继续启动。 */
fn wait_until_ready(
    child: &mut BackendProcess,
    port: u16,
    timeout: Duration,
    stop_requested: &AtomicBool,
) -> io::Result<()> {
    let started_at = Instant::now();
    let mut listening_since: Option<Instant> = None;

    loop {
        if stop_requested.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "内置后端启动已取消",
            ));
        }

        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "内置后端启动失败，进程已退出：{status}；请查看 logs/backend-console.log"
            )));
        }

        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            /*
             * Tomcat 开始监听并不一定表示 Spring 的 ApplicationReadyEvent 已执行成功。
             * 后端可能先开放端口，随后在初始化 Agent、Skills 等组件时异常退出。
             * 因此要求端口和进程连续稳定一小段时间，避免前端误判为启动成功。
             */
            let first_listening = listening_since.get_or_insert_with(Instant::now);
            if first_listening.elapsed() >= Duration::from_secs(3) {
                return Ok(());
            }
        } else {
            listening_since = None;
        }

        if started_at.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("等待内置后端端口 {port} 超时；请查看 logs/backend-console.log"),
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/** 根据当前操作系统返回安装包内 Java 启动器路径。 */
fn bundled_java(resource_dir: &Path) -> PathBuf {
    let executable = if cfg!(target_os = "windows") {
        "java.exe"
    } else {
        "java"
    };
    resource_dir.join("runtime").join("bin").join(executable)
}

/** 把用户目录转换为 Spring 接受的 file: 目录地址，并保留末尾斜杠。 */
fn spring_file_directory(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if cfg!(target_os = "windows") {
        format!("file:///{normalized}/")
    } else {
        format!("file:{normalized}/")
    }
}
