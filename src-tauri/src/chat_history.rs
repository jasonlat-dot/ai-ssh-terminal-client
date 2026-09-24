use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const HISTORY_DIRECTORY: &str = "chat-history-v1";

/// 串行化本地会话文件的读写，避免流式保存与历史列表刷新同时访问同一文件。
#[derive(Default)]
pub struct ChatHistoryState {
    lock: Mutex<()>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryScope {
    backend_url: String,
    user_id: String,
    agent_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChatSessionRequest {
    #[serde(flatten)]
    scope: ChatHistoryScope,
    title: String,
    messages: Vec<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredChatSession {
    #[serde(flatten)]
    scope: ChatHistoryScope,
    title: String,
    message_count: usize,
    created_at: u64,
    updated_at: u64,
    messages: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionSummary {
    session_id: String,
    title: String,
    message_count: usize,
    created_at: u64,
    updated_at: u64,
}

fn history_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(HISTORY_DIRECTORY))
        .map_err(|error| format!("无法定位客户端应用数据目录: {error}"))
}

fn now_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("系统时间异常: {error}"))
}

/// 使用固定 FNV-1a 算法生成文件名，保证升级 Rust/Tauri 后仍能找到原有会话。
fn scope_hash(scope: &ChatHistoryScope) -> Result<u64, String> {
    let bytes =
        serde_json::to_vec(scope).map_err(|error| format!("会话范围序列化失败: {error}"))?;
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Ok(hash)
}

fn session_path(directory: &Path, scope: &ChatHistoryScope) -> Result<PathBuf, String> {
    Ok(directory.join(format!("{:016x}.json", scope_hash(scope)?)))
}

fn read_session(path: &Path) -> Result<StoredChatSession, String> {
    let content = fs::read(path).map_err(|error| format!("读取客户端会话文件失败: {error}"))?;
    serde_json::from_slice(&content).map_err(|error| format!("解析客户端会话文件失败: {error}"))
}

#[tauri::command]
pub fn save_chat_session(
    app: AppHandle,
    state: State<'_, ChatHistoryState>,
    request: SaveChatSessionRequest,
) -> Result<(), String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "客户端会话存储锁已损坏".to_string())?;
    let directory = history_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建客户端会话目录失败: {error}"))?;

    let path = session_path(&directory, &request.scope)?;
    let previous = if path.exists() {
        read_session(&path).ok()
    } else {
        None
    };
    let timestamp = now_millis()?;
    let stored = StoredChatSession {
        scope: request.scope,
        title: request.title,
        message_count: request.messages.len(),
        created_at: previous
            .map(|session| session.created_at)
            .unwrap_or(timestamp),
        updated_at: timestamp,
        messages: request.messages,
    };
    let content = serde_json::to_vec_pretty(&stored)
        .map_err(|error| format!("序列化客户端会话失败: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content)
        .map_err(|error| format!("写入客户端会话临时文件失败: {error}"))?;

    // Windows 不允许 rename 覆盖现有文件，因此先删除旧文件，再将完整临时文件替换过去。
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("替换客户端会话文件失败: {error}"))?;
    }
    fs::rename(&temporary, &path).map_err(|error| format!("提交客户端会话文件失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn list_chat_sessions(
    app: AppHandle,
    state: State<'_, ChatHistoryState>,
    backend_url: String,
    user_id: String,
    agent_id: String,
) -> Result<Vec<ChatSessionSummary>, String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "客户端会话存储锁已损坏".to_string())?;
    let directory = history_directory(&app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&directory).map_err(|error| format!("读取客户端会话目录失败: {error}"))?;
    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        // 单个历史文件损坏时跳过该文件，不能让整个历史列表不可用。
        let Ok(session) = read_session(&path) else {
            continue;
        };
        if session.scope.backend_url == backend_url
            && session.scope.user_id == user_id
            && session.scope.agent_id == agent_id
        {
            sessions.push(ChatSessionSummary {
                session_id: session.scope.session_id,
                title: session.title,
                message_count: session.message_count,
                created_at: session.created_at,
                updated_at: session.updated_at,
            });
        }
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub fn load_chat_session(
    app: AppHandle,
    state: State<'_, ChatHistoryState>,
    scope: ChatHistoryScope,
) -> Result<Option<Vec<Value>>, String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "客户端会话存储锁已损坏".to_string())?;
    let directory = history_directory(&app)?;
    let path = session_path(&directory, &scope)?;
    if !path.exists() {
        return Ok(None);
    }
    let session = read_session(&path)?;
    if session.scope != scope {
        return Err("客户端会话文件与请求范围不匹配".to_string());
    }
    Ok(Some(session.messages))
}
