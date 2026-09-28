use std::fs::{self, File, OpenOptions};
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/** Windows 创建无控制台窗口子进程时使用的系统标志。 */
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    /** 当前后端控制台日志的绝对路径。 */
    log_path: Option<String>,
}

impl Default for BackendStatus {
    fn default() -> Self {
        Self {
            status: "stopped".into(),
            message: "内置后端尚未启动".into(),
            log_path: None,
        }
    }
}

/** 保存后端子进程及前端可读取的启动结果。 */
#[derive(Default)]
pub struct BundledBackendState {
    child: Mutex<Option<Child>>,
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
            log_path: None,
        },
    );

    let status = match start_inner(app) {
        Ok(log_path) => BackendStatus {
            status: "running".into(),
            message: "内置后端已启动".into(),
            log_path: Some(log_path.to_string_lossy().into_owned()),
        },
        Err(error) => BackendStatus {
            status: "failed".into(),
            message: error.to_string(),
            log_path: error_log_path(app).map(|path| path.to_string_lossy().into_owned()),
        },
    };
    set_status(app, status.clone());
    status
}

/** 执行资源检查、目录准备、Java 进程启动和存活确认。 */
fn start_inner(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let backend_home = resolve_backend_home(&resource_dir, app)?;
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
            return Ok(backend_home.join("logs").join("backend-console.log"));
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

    let mut command = Command::new(&java_executable);
    command
        .arg("--enable-native-access=ALL-UNNAMED")
        .arg("-jar")
        .arg(&backend_jar)
        .arg(format!(
            "--spring.config.additional-location={config_location}"
        ))
        .current_dir(&backend_home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(error_log));

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

    // 等待监听端口就绪后再显示主界面，避免前端首次请求早于 Spring Boot 启动完成。
    let server_port = read_server_port(&backend_home.join("application.yml")).unwrap_or(8888);
    wait_until_ready(&mut child, server_port, Duration::from_secs(60))?;

    let state = app.state::<BundledBackendState>();
    let mut guard = state.child.lock().map_err(|_| "内置后端进程状态锁已损坏")?;
    *guard = Some(child);
    Ok(backend_home.join("logs").join("backend-console.log"))
}

/** 返回当前内置后端状态，供页面在首次渲染和重试后展示准确结果。 */
#[tauri::command]
pub fn bundled_backend_status(state: State<'_, BundledBackendState>) -> BackendStatus {
    state.status.lock().map(|value| value.clone()).unwrap_or_else(|_| BackendStatus {
        status: "failed".into(),
        message: "无法读取内置后端状态".into(),
        log_path: None,
    })
}

/** 停止旧进程并重新读取外置配置启动后端，配置修改可通过重启立即生效。 */
#[tauri::command]
pub fn bundled_backend_restart(app: AppHandle) -> BackendStatus {
    stop(&app);
    start(&app)
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
    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
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
fn read_server_port(application_yml: &Path) -> Option<u16> {
    let content = fs::read_to_string(application_yml).ok()?;
    let mut inside_server = false;

    for line in content.lines() {
        let without_comment = line.split('#').next()?.trim_end();
        if without_comment.trim().is_empty() {
            continue;
        }

        let indentation = without_comment.len() - without_comment.trim_start().len();
        let value = without_comment.trim();
        if indentation == 0 {
            inside_server = value == "server:";
            continue;
        }
        if inside_server && indentation > 0 && value.starts_with("port:") {
            let configured = value.trim_start_matches("port:").trim();
            if let Ok(port) = configured.parse::<u16>() {
                return Some(port);
            }
            let default_value = configured.trim_end_matches('}').rsplit(':').next()?;
            return default_value.parse::<u16>().ok();
        }
    }
    None
}

/** 等待 Spring Boot 开始监听；进程提前退出或超时会阻止客户端带着不可用后端继续启动。 */
fn wait_until_ready(child: &mut Child, port: u16, timeout: Duration) -> io::Result<()> {
    let started_at = Instant::now();
    let mut listening_since: Option<Instant> = None;

    loop {
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
