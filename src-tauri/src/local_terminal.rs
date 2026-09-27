use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// 本地终端命令使用的共享状态。
///
/// 每个会话都持有独立的 ConPTY master、输入流和子进程。前端只传递随机会话 ID，
/// 不允许指定任意可执行文件，因此 Windows 上始终启动系统配置的 cmd.exe。
#[derive(Default)]
pub struct LocalTerminalState {
    sessions: Mutex<HashMap<String, Arc<LocalTerminalSession>>>,
}

struct LocalTerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    closed: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalOpen {
    session_id: String,
    shell: String,
    cwd: String,
}

fn lock_error(name: &str) -> String {
    format!("本地终端 {name} 状态不可用")
}

impl LocalTerminalSession {
    /// 把键盘输入写入 ConPTY。writer 加锁保证粘贴和普通按键不会交叉写入。
    fn write(&self, input: &str) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("本地终端已关闭".to_string());
        }

        let mut writer = self.writer.lock().map_err(|_| lock_error("输入"))?;
        writer
            .write_all(input.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("写入本地终端失败：{error}"))
    }

    /// 将 xterm 的字符行列同步给 ConPTY，使 cmd 的换行和全屏程序尺寸正确。
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Ok(());
        }

        self.master
            .lock()
            .map_err(|_| lock_error("窗口"))?
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("调整本地终端尺寸失败：{error}"))
    }

    /// 幂等终止 cmd 子进程；reader 线程会在管道结束后自行退出。
    fn close(&self) -> Result<(), String> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let mut child = self.child.lock().map_err(|_| lock_error("进程"))?;
        child
            .kill()
            .map_err(|error| format!("关闭本地终端失败：{error}"))
    }
}

/// 创建本地伪终端。
///
/// Windows 的 portable-pty 后端使用 ConPTY；shell 优先读取 COMSPEC，并回退到
/// cmd.exe。初始目录为当前用户目录，避免终端默认落到安装目录。
#[tauri::command]
pub fn local_terminal_open(
    cols: u16,
    rows: u16,
    on_event: Channel<Value>,
    state: State<'_, LocalTerminalState>,
) -> Result<LocalTerminalOpen, String> {
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    let cwd = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOMEDRIVE").and_then(|drive| {
            std::env::var("HOMEPATH").map(|path| format!("{drive}{path}"))
        }))
        .unwrap_or_else(|_| ".".to_string());

    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("创建本地终端失败：{error}"))?;

    let mut command = CommandBuilder::new(&shell);
    command.cwd(&cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动 cmd.exe 失败：{error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("创建本地终端输出流失败：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("创建本地终端输入流失败：{error}"))?;

    let session_id = format!(
        "local-{}-{}",
        std::process::id(),
        SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let session = Arc::new(LocalTerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        closed: AtomicBool::new(false),
    });

    state
        .sessions
        .lock()
        .map_err(|_| lock_error("会话"))?
        .insert(session_id.clone(), Arc::clone(&session));

    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    if !session.closed.swap(true, Ordering::SeqCst) {
                        let _ = on_event.send(json!({ "type": "exit" }));
                    }
                    break;
                }
                Ok(size) => {
                    let _ = on_event.send(json!({
                        "type": "data",
                        "data": &buffer[..size],
                    }));
                }
                Err(error) => {
                    if !session.closed.swap(true, Ordering::SeqCst) {
                        let _ = on_event.send(json!({
                            "type": "error",
                            "message": format!("读取本地终端失败：{error}"),
                        }));
                    }
                    break;
                }
            }
        }
    });

    Ok(LocalTerminalOpen {
        session_id,
        shell,
        cwd,
    })
}

#[tauri::command]
/// 写入指定本地终端。前端只能引用已登记的 session_id，不能指定系统进程。
pub fn local_terminal_write(
    session_id: String,
    input: String,
    state: State<'_, LocalTerminalState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| lock_error("会话"))?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "本地终端不存在或已关闭".to_string())?;
    session.write(&input)
}

#[tauri::command]
/// 调整指定本地终端的字符尺寸，像素尺寸由 ConPTY 自行处理。
pub fn local_terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, LocalTerminalState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| lock_error("会话"))?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "本地终端不存在或已关闭".to_string())?;
    session.resize(cols, rows)
}

#[tauri::command]
/// 从会话表移除并终止本地 cmd；重复关闭按成功处理，便于前端幂等清理。
pub fn local_terminal_close(
    session_id: String,
    state: State<'_, LocalTerminalState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| lock_error("会话"))?
        .remove(&session_id);

    match session {
        Some(session) => session.close(),
        None => Ok(()),
    }
}
