use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::CloseHandle;
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_LIMIT_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/** Windows 创建无控制台窗口子进程时使用的系统标志。 */
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/**
 * Windows Job Object 句柄。
 *
 * 持有这个结构的对象在 drop 时会自动 `CloseHandle` 释放 job 句柄。
 * job 一旦 `CloseHandle`，里面所有未结束的子进程都会被内核强制 kill（受
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 标志约束）。
 *
 * 这层保护解决"客户端被任务管理器结束 / 崩溃退出时 java 子进程变孤儿继续监听 8888"的
 * 问题：Tauri 主进程一旦终止、句柄一释放，子进程立即回收。
 */
#[cfg(target_os = "windows")]
struct JobObject(isize);

#[cfg(target_os = "windows")]
impl JobObject {
    fn new() -> io::Result<Self> {
        // safety: CreateJobObjectW 返回的 handle 由调用者负责 CloseHandle。
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation = JOBOBJECT_BASIC_LIMIT_INFORMATION {
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            ..unsafe { std::mem::zeroed() }
        };

        // safety: info 是栈上合法内存，length 是字节数。
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let err = io::Error::last_os_error();
            unsafe { CloseHandle(handle); }
            return Err(err);
        }
        Ok(Self(handle as isize))
    }

    fn attach(&self, child: &Child) -> io::Result<()> {
        let process_handle = child.as_raw_handle() as isize;
        // safety: process_handle 来自刚刚 spawn 的 Child，job handle 由本对象管理。
        let ok = unsafe { AssignProcessToJobObject(self.0 as _, process_handle as _) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for JobObject {
    fn drop(&mut self) {
        if self.0 != 0 {
            // safety: self.0 来自 CreateJobObjectW，且本类型是唯一持有者。
            unsafe { CloseHandle(self.0 as _); }
        }
    }
}

/**
 * 非 Windows 平台的占位实现：依赖 `Child::kill()` 与 `ExitRequested` 拦截，
 * 仍能覆盖正常退出路径，但对"进程被强制结束"的兜底不如 Windows Job Object 强。
 */
#[cfg(not(target_os = "windows"))]
struct JobObject;

#[cfg(not(target_os = "windows"))]
impl JobObject {
    fn new() -> io::Result<Self> { Ok(Self) }
    fn attach(&self, _child: &Child) -> io::Result<()> { Ok(()) }
}

/** 安装包内后端 JAR 的固定资源名称。 */
const BACKEND_JAR_NAME: &str = "ai-ssh-terminal-server-app.jar";

/** 前端可查询的内置后端运行状态。 */
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    /** starting、running、failed 或 stopped。 */
    status: String,
    /** 面向用户的状态说明；失败时包含真实启动原因。 */
    message: String,
    /** 当前后端日志目录的绝对路径。 */
    log_directory: Option<String>,
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

/** 折叠策略：始终将前端保存的结果写为 `${ENV:a,b,c}` 单字符串（用于环境变量友好的列表字段）。 */
#[derive(Clone, Copy)]
enum ConfigValueCollapse {
    /// 默认：保留原 YAML 形态，块样式继续用块样式，单字符串继续用单字符串
    None,
    /// 始终折叠为单字符串 `${ENV:a,b,c}`，环境变量名从第一条历史值推断
    EnvironmentString,
}

/** 前端允许编辑的配置白名单，避免客户端提交任意 YAML 路径。 */
struct ConfigField {
    key: &'static str,
    path: &'static [&'static str],
    kind: ConfigValueKind,
    style: ConfigValueStyle,
    sensitive: bool,
    /// 仅对 List 字段生效；置为 EnvironmentString 时，前端保存后会折叠为 `${ENV:a,b,c}`
    collapse: ConfigValueCollapse,
}

const CONFIG_FIELDS: &[ConfigField] = &[
    ConfigField { key: "serverPort", path: &["server", "port"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "dataDirectory", path: &["app", "config", "data-directory"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiBaseUrl", path: &["openai", "ai-api", "base-url"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiApiKey", path: &["openai", "ai-api", "api-key"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiCompletionsPath", path: &["openai", "ai-api", "completions-path"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiEmbeddingsPath", path: &["openai", "ai-api", "embeddings-path"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiProxyEnabled", path: &["openai", "ai-api", "proxy", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiProxyHost", path: &["openai", "ai-api", "proxy", "host"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiProxyPort", path: &["openai", "ai-api", "proxy", "port"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiNonProxyHosts", path: &["openai", "ai-api", "proxy", "non-proxy-hosts"], kind: ConfigValueKind::List, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::EnvironmentString },
    ConfigField { key: "aiModelName", path: &["openai", "chat-model", "model-name"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiReasoningEffort", path: &["openai", "chat-model", "reasoning-effort"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "aiSupportedMediaTypes", path: &["openai", "chat-model", "supported-media-types"], kind: ConfigValueKind::List, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::EnvironmentString },
    ConfigField { key: "fileStorageDefaultId", path: &["ai", "file", "storage", "default-id"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "localStorageEnabled", path: &["ai", "file", "storage", "local", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "localStorageId", path: &["ai", "file", "storage", "local", "storage-id"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "localRootDirectory", path: &["ai", "file", "storage", "local", "root-directory"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "localPublicBaseUrl", path: &["ai", "file", "storage", "local", "public-base-url"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "localSigningSecret", path: &["ai", "file", "storage", "local", "signing-secret"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioEnabled", path: &["ai", "file", "storage", "minio", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioStorageId", path: &["ai", "file", "storage", "minio", "storage-id"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioEndpoint", path: &["ai", "file", "storage", "minio", "endpoint"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioPublicEndpoint", path: &["ai", "file", "storage", "minio", "public-endpoint"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioAccessKey", path: &["ai", "file", "storage", "minio", "access-key"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioSecretKey", path: &["ai", "file", "storage", "minio", "secret-key"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioBucket", path: &["ai", "file", "storage", "minio", "bucket"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioRegion", path: &["ai", "file", "storage", "minio", "region"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioConnectTimeout", path: &["ai", "file", "storage", "minio", "connect-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioReadTimeout", path: &["ai", "file", "storage", "minio", "read-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioWriteTimeout", path: &["ai", "file", "storage", "minio", "write-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "minioCallTimeout", path: &["ai", "file", "storage", "minio", "call-timeout"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "sshProxyEnabled", path: &["ai", "ssh", "http-proxy", "enabled"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "sshProxyHost", path: &["ai", "ssh", "http-proxy", "host"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "sshProxyPort", path: &["ai", "ssh", "http-proxy", "port"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Plain, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "sshProxyUsername", path: &["ai", "ssh", "http-proxy", "username"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: false, collapse: ConfigValueCollapse::None },
    ConfigField { key: "sshProxyPassword", path: &["ai", "ssh", "http-proxy", "password"], kind: ConfigValueKind::Scalar, style: ConfigValueStyle::Text, sensitive: true, collapse: ConfigValueCollapse::None },
];

impl Default for BackendStatus {
    fn default() -> Self {
        Self {
            status: "stopped".into(),
            message: "内置后端尚未启动".into(),
            log_directory: None,
        }
    }
}

/** 保存后端子进程及前端可读取的启动结果。 */
#[derive(Default)]
pub struct BundledBackendState {
    child: Mutex<Option<Child>>,
    /// Windows 上把 java 子进程挂进 Job Object；drop 时强制 kill。
    /// `Default` 给出 None，避免在不需要 Job 的场景下分配内核对象。
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    job: Mutex<Option<JobObject>>,
    status: Mutex<BackendStatus>,
}

/**
 * 准备外置目录并启动安装包内置的 Java 后端。
 *
 * 用户数据目录与安装目录分离：安装升级只替换只读资源，不覆盖用户修改过的配置和数据。
 */
pub fn start(app: &AppHandle) -> BackendStatus {
    set_status(
        app,
        BackendStatus {
            status: "starting".into(),
            message: "正在启动内置后端…".into(),
            log_directory: None,
        },
    );

    let status = match start_inner(app) {
        Ok(log_directory) => BackendStatus {
            status: "running".into(),
            message: "内置后端已启动".into(),
            log_directory: Some(log_directory.to_string_lossy().into_owned()),
        },
        Err(error) => BackendStatus {
            status: "failed".into(),
            message: error.to_string(),
            log_directory: error_log_directory(app)
                .map(|path| path.to_string_lossy().into_owned()),
        },
    };
    set_status(app, status.clone());
    status
}

/** 执行资源检查、目录准备、Java 进程启动和存活确认。 */
fn start_inner(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let backend_home = resolve_backend_home(&resource_dir, app)?;
    let user_home = app.path().home_dir()?;
    let data_home = read_data_directory(&backend_home.join("application.yml"), &user_home)
        .unwrap_or_else(|| backend_home.clone());
    prepare_backend_data(&data_home)?;
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
            return Ok(data_home.join("logs"));
        }
        return Err(format!(
            "安装包缺少内置后端资源：java={} jar={}",
            java_executable.display(),
            backend_jar.display()
        )
        .into());
    }

    let config_location = spring_file_directory(&backend_home);

    // 配置目录与统一数据目录相互独立；修改 data-directory 只切换
    // SQLite、附件和日志的新写入位置，不移动原有文件。
    let log_dir = data_home.join("logs");
    fs::create_dir_all(&log_dir)?;

    let mut command = Command::new(&java_executable);
    command
        .arg("--enable-native-access=ALL-UNNAMED")
        .arg("-Dlogging.path=".to_string() + &log_dir.to_string_lossy())
        .arg("-jar")
        .arg(&backend_jar)
        .arg(format!(
            "--spring.config.additional-location={config_location}"
        ))
        .current_dir(&backend_home)
        .stdin(Stdio::null())
        // Logback 已经将运行日志写入 logs 目录。桌面壳不再额外复制一份
        // stdout/stderr 到 backend-console.log，避免日志重复和无限追加。
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // 正式版是 Windows GUI 程序，启动 Java 时不应弹出额外的黑色控制台窗口。
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "无法启动内置后端，java={} jar={}：{error}",
                java_executable.display(),
                backend_jar.display()
            ),
        )
    })?;

    // 把 java 子进程挂进 Job Object；这样即便客户端被任务管理器强制结束，
    // 操作系统也会回收 java 进程，避免 8888 端口被遗留进程占用。
    let job = JobObject::new().inspect_err(|error| {
        eprintln!("创建 Job Object 失败，继续启动后端：{error}");
    });
    if let Ok(job) = &job {
        if let Err(error) = job.attach(&child) {
            eprintln!("将 java 子进程挂入 Job Object 失败：{error}");
        }
    }

    // 等待监听端口就绪后再显示主界面，避免前端首次请求早于 Spring Boot 启动完成。
    let server_port = read_server_port(&backend_home).unwrap_or(8888);
    wait_until_ready(&mut child, server_port, Duration::from_secs(60))?;

    let state = app.state::<BundledBackendState>();
    let mut guard = state.child.lock().map_err(|_| "内置后端进程状态锁已损坏")?;
    *guard = Some(child);
    drop(guard);
    if let Ok(job) = job {
        let mut job_guard = state.job.lock().map_err(|_| "内置后端 Job Object 状态锁已损坏")?;
        *job_guard = Some(job);
    }
    Ok(log_dir)
}

/** 返回当前内置后端状态，供页面在首次渲染和重试后展示准确结果。 */
#[tauri::command]
pub fn bundled_backend_status(state: State<'_, BundledBackendState>) -> BackendStatus {
    state.status.lock().map(|value| value.clone()).unwrap_or_else(|_| BackendStatus {
        status: "failed".into(),
        message: "无法读取内置后端状态".into(),
        log_directory: None,
    })
}

/** 停止旧进程并重新读取外置配置启动后端，配置修改可通过重启立即生效。 */
#[tauri::command]
pub fn bundled_backend_restart(app: AppHandle) -> BackendStatus {
    stop(&app);
    start(&app)
}

/** 读取当前 application.yml 与活动 Profile 中真正生效的桌面配置。 */
#[tauri::command]
pub fn bundled_backend_config(app: AppHandle) -> Result<BackendConfigView, String> {
    load_backend_config(&app).map_err(|error| error.to_string())
}

/**
 * 精确更新配置字段。每个字段写回它当前的来源文件，不创建隐藏的高优先级覆盖文件。
 * 写入前保留同目录 .bak 副本，用户手工维护的其他 YAML 内容不会被整体重写。
 */
#[tauri::command]
pub fn bundled_backend_save_config(app: AppHandle, update: BackendConfigUpdate) -> Result<BackendConfigView, String> {
    save_backend_config(&app, update).map_err(|error| error.to_string())?;
    load_backend_config(&app).map_err(|error| error.to_string())
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
    })
}

/** 校验并保存设置页支持的字段。修改数据目录只写 YAML，不迁移旧数据。 */
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
    for key in ["aiProxyEnabled", "localStorageEnabled", "minioEnabled", "sshProxyEnabled"] {
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
    Err(io::Error::new(io::ErrorKind::NotFound, format!("配置项 {} 不存在", field.path.join("."))))
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

/** 读取 YAML 列表：支持块样式（一行一项）和带环境变量的内联单字符串（`${ENV:a,b,c}`）两种格式。
 * 块样式按行解析；内联单字符串从 ${ENV:default} 取出 default，按逗号拆成多行返回给设置页 textarea。 */
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
            let value = raw_value.trim();
            if !value.is_empty() {
                // 内联单字符串形态：${ENV:a,b,c} 或 [a, b, c]
                if placeholder_environment(value).is_some() {
                    let default = placeholder_default(value);
                    return Some(default.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"));
                }
                return Some(value.trim_matches(['[', ']']).split(',').map(str::trim).collect::<Vec<_>>().join("\n"));
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
        }
        ConfigValueKind::List => replace_yaml_list(&content, field.path, &located.raw, new_value, field.collapse, located.environment.as_deref()),
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

/** 替换 YAML 列表。同序号原值有环境变量时继续保留该变量名称；
 * 当字段要求折叠为环境变量单字符串时，把新值整体写入 `${ENV:a,b,c}`，
 * 避免用户保存后丢失环境变量名。块样式下保留逐项独立环境变量（_1/_2/_3）的能力。 */
fn replace_yaml_list(content: &str, path: &[&str], old_raw: &str, new_value: &str, collapse: ConfigValueCollapse, env_hint: Option<&str>) -> Option<String> {
    let old_items = old_raw.lines().collect::<Vec<_>>();
    let new_items = new_value.lines().map(str::trim).filter(|item| !item.is_empty()).collect::<Vec<_>>();
    // 折叠条件：字段声明强制折叠，或原值是单行且首项本身带环境变量占位符
    let force_collapse = matches!(collapse, ConfigValueCollapse::EnvironmentString);
    let collapse_environment = if force_collapse || old_items.len() == 1 {
        old_items.iter().find_map(|item| placeholder_environment(item))
            .or_else(|| env_hint.map(String::from))
            .or_else(|| yaml_key_environment(content, path))
    } else {
        None
    };

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
            if let Some(environment) = collapse_environment.as_ref() {
                // 折叠为单字符串：保留原 `${ENV:...,...,...}`，原地替换冒号后的默认值
                let joined = new_items.join(",");
                let rendered = format!("${{{environment}:{joined}}}");
                output.push(format!("{}{}: {rendered}", " ".repeat(indent), key));
            } else if force_collapse {
                // 强制折叠但原值没有环境变量名（用户曾手工编辑去掉）：直接写纯逗号字符串
                let joined = new_items.join(",");
                output.push(format!("{}{}: {joined}", " ".repeat(indent), key));
            } else {
                output.push(line.to_string());
                for (index, item) in new_items.iter().enumerate() {
                    let rendered = old_items.get(index)
                        .and_then(|old| placeholder_environment(old))
                        .map(|environment| format!("${{{environment}:{item}}}"))
                        .unwrap_or_else(|| yaml_string(item));
                    output.push(format!("{}- {rendered}", " ".repeat(indent + 2)));
                }
            }
            target_indent = Some(indent);
            replaced = true;
            continue;
        }
        output.push(line.to_string());
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

/** 在 YAML 内容中查找指定 key 行里嵌的 `${ENV:...}` 环境变量名。
 * 支持内联单字符串形态（如 `${AI_MODEL_NON_PROXY_HOSTS:localhost,127.0.0.1}`），
 * 也支持块样式下的父级 key 行（`non-proxy-hosts:` 行可能紧跟在带 env 的 key 后面）。 */
fn yaml_key_environment(content: &str, path: &[&str]) -> Option<String> {
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
            return placeholder_environment(raw_value.trim());
        }
        if raw_value.trim().is_empty() { parents.push((indent, key.to_string())); }
    }
    None
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
        ConfigValueKind::List => raw.lines().map(|item| effective_scalar(item, placeholder_environment(item).as_deref())).collect::<Vec<_>>().join("\n"),
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

/** 更新共享状态；锁异常时不再让桌面客户端崩溃。 */
fn set_status(app: &AppHandle, status: BackendStatus) {
    if let Ok(mut current) = app.state::<BundledBackendState>().status.lock() {
        *current = status;
    }
}

/** 客户端正常退出时终止它启动的 Java 后端，避免后台残留进程继续占用端口。 */
pub fn stop(app_handle: &AppHandle) {
    let state = app_handle.state::<BundledBackendState>();

    // 先取走子进程句柄。drop 顺序：先 take Child、再 take JobObject，
    // 让 JobObject drop 时关闭 job 句柄，触发 KILL_ON_JOB_CLOSE，
    // 即使 TerminateProcess 没生效也能兜底。
    let child = {
        let Ok(mut guard) = state.child.lock() else { return; };
        guard.take()
    };

    if let Some(mut child) = child {
        // 先尝试主动 kill；Wait 阻塞等待，避免子进程成为孤儿。
        let _ = child.kill();
        // 给 Java 一点时间响应 TerminateProcess，避免 wait() 立即返回后端口尚未释放。
        // wait() 会一直阻塞到进程真正退出，最多 ~1s。
        let _ = child.wait();
    }

    // drop job handle，会触发内核回收 job 内全部进程（包括 Attach 时漏掉的子进程）。
    let _ = state.job.lock().ok().map(|mut guard| guard.take());
}

/**
 * 确定后端外置配置目录。
 *
 * 首次启动默认使用 `${user.home}/.ai-ssh-terminal` 存放 application*.yml。
 * `app.config.data-directory` 只控制 SQLite、附件和日志的新写入位置，不改变配置目录，
 * 也不触发任何数据复制或迁移。
 */
fn resolve_backend_home(resource_dir: &Path, app: &AppHandle) -> io::Result<PathBuf> {
    let launcher_directory = app
        .path()
        .app_local_data_dir()
        .map_err(io::Error::other)?;
    let default_home = app
        .path()
        .home_dir()
        .map_err(io::Error::other)?
        .join(".ai-ssh-terminal");
    let location_file = launcher_directory.join("backend-location.txt");

    fs::create_dir_all(&launcher_directory)?;
    let backend_home = fs::read_to_string(&location_file)
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(default_home);

    prepare_backend_home(resource_dir, &backend_home)?;
    fs::write(location_file, backend_home.to_string_lossy().as_bytes())?;
    Ok(backend_home)
}

/** 从 application.yml 读取统一数据根目录，支持绝对路径和默认占位符写法。 */
fn read_data_directory(application_yml: &Path, user_home: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(application_yml).ok()?;
    let configured = content
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .find_map(|line| line.strip_prefix("data-directory:").map(str::trim))?;

    eprintln!("[bundled_backend] read_data_directory raw='{configured}'");

    // 默认值与 Spring 端保持一致：${AI_SSH_TERMINAL_HOME:${user.home}/.ai-ssh-terminal}。
    // 这里直接把整条字符串里的占位符展开，行为对齐 Spring 的 PropertySourcesPropertyResolver，
    // 避免"包含占位符就短路丢掉了绝对路径"的 bug。
    let resolved = resolve_data_directory_placeholders(
        configured,
        user_home,
        application_yml,
    );
    eprintln!("[bundled_backend] read_data_directory resolved='{}'", resolved.display());
    Some(resolved)
}

/**
 * 把 yml 里的 data-directory 字符串展开成实际路径。
 *
 * 支持：
 *   - `${AI_SSH_TERMINAL_HOME}`                 → env 变量；未设则回退到用户目录
 *   - `${AI_SSH_TERMINAL_HOME:fallback}`        → env 变量；未设则用 fallback
 *   - `${user.home}` / `${user.home}/xxx`       → 用户主目录
 *   - 绝对路径（Windows 如 `E:\ai-ssh\...`）      → 直接使用
 *
 * 历史 bug：之前的实现只要看到 `AI_SSH_TERMINAL_HOME` 字符串就直接走环境变量分支，
 * 忽略了用户在 yml 里写下的绝对路径，导致设置页改路径后日志依然写到用户目录。
 */
fn resolve_data_directory_placeholders(
    raw: &str,
    user_home: &Path,
    application_yml: &Path,
) -> PathBuf {
    let default_home = user_home.join(".ai-ssh-terminal");
    let env_home = std::env::var_os("AI_SSH_TERMINAL_HOME").map(PathBuf::from);

    // 行为与 Spring 的 PropertySourcesPropertyResolver 对齐：
    //   - `${AI_SSH_TERMINAL_HOME}`                       → env 变量；未设则回退用户目录
    //   - `${AI_SSH_TERMINAL_HOME:fallback}`              → env 变量；未设则用 fallback
    //   - `${user.home}`                                  → 用户主目录
    //   - 其它 `${...}` 占位符（非 AI_SSH_TERMINAL_HOME / user.home）保留原样
    let expanded = expand_placeholders(raw, env_home.as_ref(), &default_home, user_home, application_yml);

    let trimmed = expanded.trim_matches(['\'', '"']);
    let path = PathBuf::from(trimmed);

    if path.as_os_str().is_empty() {
        return default_home;
    }
    if path.is_absolute() {
        path
    } else {
        // 相对路径以 yml 所在目录为基准
        application_yml
            .parent()
            .map(|p| p.join(path))
            .unwrap_or(default_home)
    }
}

/** 返回 UTF-8 字符串中第 `start` 个字节之后的下一个字符边界。 */
fn next_char_boundary(s: &str, start: usize) -> usize {
    let mut i = start + 1;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/**
 * 解析一个 `${...}` 占位符体（不含外层 `${` `}`）。
 *
 * 仅处理 `AI_SSH_TERMINAL_HOME` 与 `user.home` 家族；其它占位符原样保留。
 *
 * 注意：fallback 里允许继续嵌套占位符（例如
 * `${AI_SSH_TERMINAL_HOME:${user.home}/.ai-ssh-terminal}`），
 * 解析时把 fallback 当作新 raw 重新进入展开流程，避免把内层 `${}` 的 `}`
 * 误判为外层结束符——这是历史上 find('}') 写法在 yml 默认值上栈溢出的根因。
 */
fn resolve_placeholder_body(
    body: &str,
    env_home: Option<&PathBuf>,
    default_home: &Path,
    user_home: &Path,
    application_yml: &Path,
) -> String {
    if let Some(after_colon) = body.strip_prefix("AI_SSH_TERMINAL_HOME:") {
        // ${AI_SSH_TERMINAL_HOME:fallback}
        let resolved = env_home
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| after_colon.to_string());
        // fallback 里可能还包含其它占位符（如 `${user.home}`），继续展开。
        return expand_placeholders(&resolved, env_home, default_home, user_home, application_yml);
    }
    if body == "AI_SSH_TERMINAL_HOME" {
        // ${AI_SSH_TERMINAL_HOME}
        return env_home
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| default_home.to_string_lossy().into_owned());
    }
    if body == "user.home" {
        // ${user.home}
        return user_home.to_string_lossy().into_owned();
    }
    // 其它 `${...}` 占位符原样保留
    format!("${{{body}}}")
}

/**
 * 把 raw 字符串里的 `${...}` 占位符全部展开为实际值。
 * 与 `resolve_data_directory_placeholders` 共享同一份字符级扫描逻辑，
 * 这里只是它处理单个占位符 body 后的递归出口。
 */
fn expand_placeholders(
    raw: &str,
    env_home: Option<&PathBuf>,
    default_home: &Path,
    user_home: &Path,
    application_yml: &Path,
) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            let body_start = i + 2;
            let mut depth: i32 = 1;
            let mut j = body_start;
            while j < bytes.len() && depth > 0 {
                match bytes[j] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                if depth == 0 { break; }
                j += 1;
            }
            if depth != 0 {
                out.push_str(&raw[i..]);
                break;
            }
            let body = &raw[body_start..j];
            let resolved = resolve_placeholder_body(body, env_home, default_home, user_home, application_yml);
            out.push_str(&resolved);
            i = j + 1;
        } else {
            let ch_end = next_char_boundary(raw, i);
            out.push_str(&raw[i..ch_end]);
            i = ch_end;
        }
    }
    out
}

/** 尽最大可能算出日志路径，让前端在启动早期失败时也能给出排查位置。
 *
 * 注意：这里**只做纯路径解析**，不调用 `resolve_backend_home`，
 * 避免在错误恢复场景下触发配置初始化副作用。
 */
fn error_log_directory(app: &AppHandle) -> Option<PathBuf> {
    let user_home = app.path().home_dir().ok()?;
    let location_file = app.path().app_local_data_dir().ok()?.join("backend-location.txt");

    let backend_home = fs::read_to_string(&location_file)
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
        .map(|home| {
            // location 文件存在时再尝试读 yml，确认 data-directory 是否已更新到新位置；
            // 注意：这里只读取，不会触发 resolve_backend_home 的配置初始化副作用。
            let application_yml = home.join("application.yml");
            read_data_directory(&application_yml, &user_home).unwrap_or(home)
        })
        .unwrap_or_else(|| user_home.join(".ai-ssh-terminal"));

    Some(backend_home.join("logs"))
}

/**
 * 创建数据、上传和日志目录，并按“application.yml 是否存在”决定是否初始化默认配置。
 * application.yml 存在时不复制任何 YAML，允许用户自由使用 dev、sit 或自定义 profile。
 */
fn prepare_backend_home(resource_dir: &Path, backend_home: &Path) -> io::Result<()> {
    fs::create_dir_all(backend_home)?;

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

/** 只创建新的统一数据目录结构，不复制或删除任何旧数据。 */
fn prepare_backend_data(data_home: &Path) -> io::Result<()> {
    fs::create_dir_all(data_home.join("data"))?;
    fs::create_dir_all(data_home.join("files"))?;
    fs::create_dir_all(data_home.join("logs"))?;
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

/**
 * 读取 application.yml 顶层 server.port。
 * 同时识别 8888 和 ${SERVER_PORT:8888}，解析失败时由调用方使用默认端口。
 */
fn read_server_port(backend_home: &Path) -> Option<u16> {
    // 与设置页使用同一套 Profile 优先级，避免端口写在 application-prod.yml 时等待错误端口。
    let application_file = backend_home.join("application.yml");
    let profiles = active_profiles(&application_file).ok()?;
    let files = config_files(backend_home, &profiles);
    let port = locate_config_value(&files, &["server", "port"]).ok()?;
    effective_scalar(&port.raw, port.environment.as_deref()).parse::<u16>().ok()
}

/** 等待 Spring Boot 开始监听；进程提前退出或超时会阻止客户端带着不可用后端继续启动。 */
fn wait_until_ready(child: &mut Child, port: u16, timeout: Duration) -> io::Result<()> {
    let started_at = Instant::now();
    let mut listening_since: Option<Instant> = None;

    loop {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "内置后端启动失败，进程已退出：{status}；请查看日志目录"
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
                format!("等待内置后端端口 {port} 超时；请查看日志目录"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_from_block_without_env() {
        let content = "openai:\n  ai-api:\n    proxy:\n      non-proxy-hosts:\n        - 'localhost'\n        - '127.0.0.1'\n        - '192.168.*'\n";
        let old_raw = "- 'localhost'\n- '127.0.0.1'\n- '192.168.*'";
        let new_value = "localhost\n127.0.0.1\n192.168.*\n10.*";
        // env_hint 从原 YAML 行猜到，保持环境变量能力
        let updated = replace_yaml_list(content, &["openai", "ai-api", "proxy", "non-proxy-hosts"], old_raw, new_value, ConfigValueCollapse::EnvironmentString, Some("AI_MODEL_NON_PROXY_HOSTS")).unwrap();
        println!("\n--- collapse_from_block_without_env ---\n{updated}");
        assert!(updated.contains("non-proxy-hosts: ${AI_MODEL_NON_PROXY_HOSTS:localhost,127.0.0.1,192.168.*,10.*}"));
        assert!(!updated.contains("        -"));
    }

    #[test]
    fn collapse_from_inline_env() {
        let content = "openai:\n  ai-api:\n    proxy:\n      non-proxy-hosts: ${AI_MODEL_NON_PROXY_HOSTS:localhost,127.0.0.1,192.168.*}\n";
        let old_raw = "${AI_MODEL_NON_PROXY_HOSTS:localhost,127.0.0.1,192.168.*}";
        let new_value = "localhost\n127.0.0.1\n10.*";
        // inline env 已从 old_raw 解析，无需 hint
        let updated = replace_yaml_list(content, &["openai", "ai-api", "proxy", "non-proxy-hosts"], old_raw, new_value, ConfigValueCollapse::EnvironmentString, None).unwrap();
        println!("\n--- collapse_from_inline_env ---\n{updated}");
        assert!(updated.contains("non-proxy-hosts: ${AI_MODEL_NON_PROXY_HOSTS:localhost,127.0.0.1,10.*}"));
    }

    #[test]
    fn read_inline_env_to_textarea_lines() {
        let content = "openai:\n  ai-api:\n    proxy:\n      non-proxy-hosts: ${AI_MODEL_NON_PROXY_HOSTS:localhost,127.0.0.1,192.168.*}\n";
        let read = yaml_list_value(content, &["openai", "ai-api", "proxy", "non-proxy-hosts"]).unwrap();
        println!("\n--- read_inline_env_to_textarea_lines ---\n{read:?}");
        assert_eq!(read, "localhost\n127.0.0.1\n192.168.*");
    }

    #[test]
    fn resolve_data_directory_default_value_with_nested_user_home() {
        // yml 默认值：env 没设时，fallback 里的 ${user.home} 必须被正确展开为用户主目录，
        // 不能因为内部 `}` 被误判为外层结束符。
        let user_home = Path::new("C:/Users/Administrator");
        let application_yml = user_home.join(".ai-ssh-terminal").join("application.yml");
        // 关键测试：临时屏蔽 AI_SSH_TERMINAL_HOME，避免本地环境变量影响测试。
        // 这里调用直接走 resolve_data_directory_placeholders，不依赖环境变量。
        let result = resolve_data_directory_placeholders(
            "${AI_SSH_TERMINAL_HOME:${user.home}/.ai-ssh-terminal}",
            user_home,
            &application_yml,
        );
        assert_eq!(
            result,
            PathBuf::from("C:/Users/Administrator/.ai-ssh-terminal")
        );
    }

    #[test]
    fn resolve_data_directory_absolute_path_preserved() {
        let user_home = Path::new("C:/Users/Administrator");
        let application_yml = user_home.join(".ai-ssh-terminal").join("application.yml");
        // 之前老 bug：包含 "AI_SSH_TERMINAL_HOME" 字符串就走环境变量分支，丢掉了绝对路径。
        let result = resolve_data_directory_placeholders(
            "E:/ai-ssh/ai-ssh-terminal",
            user_home,
            &application_yml,
        );
        assert_eq!(result, PathBuf::from("E:/ai-ssh/ai-ssh-terminal"));
    }

}
