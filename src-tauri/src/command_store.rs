use crate::cache::cache_directory;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Mutex;
use tauri::{AppHandle, State};

const COMMAND_FILE: &str = "commands.json";

#[derive(Default)]
pub struct CommandStoreState {
    lock: Mutex<()>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCommand {
    id: String,
    name: String,
    command: String,
    category: String,
    icon: String,
}

fn validate(commands: &[StoredCommand]) -> Result<(), String> {
    if commands.iter().any(|item| {
        item.id.trim().is_empty()
            || item.name.trim().is_empty()
            || item.command.trim().is_empty()
            || item.category.trim().is_empty()
    }) {
        return Err("常用命令包含空字段，无法保存".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn load_commands(
    app: AppHandle,
    state: State<'_, CommandStoreState>,
) -> Result<Option<Vec<StoredCommand>>, String> {
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "常用命令存储锁已损坏".to_string())?;
    let path = cache_directory(&app, "command")?.join(COMMAND_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read(&path).map_err(|error| format!("读取常用命令失败: {error}"))?;
    let commands: Vec<StoredCommand> =
        serde_json::from_slice(&content).map_err(|error| format!("解析常用命令失败: {error}"))?;
    validate(&commands)?;
    Ok(Some(commands))
}

#[tauri::command]
pub fn save_commands(
    app: AppHandle,
    state: State<'_, CommandStoreState>,
    commands: Vec<StoredCommand>,
) -> Result<(), String> {
    validate(&commands)?;
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "常用命令存储锁已损坏".to_string())?;
    let directory = cache_directory(&app, "command")?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建常用命令目录失败: {error}"))?;
    let path = directory.join(COMMAND_FILE);
    let temporary = directory.join(format!("{COMMAND_FILE}.tmp"));
    let content = serde_json::to_vec_pretty(&commands)
        .map_err(|error| format!("序列化常用命令失败: {error}"))?;
    fs::write(&temporary, content).map_err(|error| format!("写入常用命令失败: {error}"))?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("替换常用命令失败: {error}"))?;
    }
    fs::rename(&temporary, &path).map_err(|error| format!("提交常用命令失败: {error}"))?;
    Ok(())
}
