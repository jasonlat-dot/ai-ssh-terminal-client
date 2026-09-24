use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn cache_directory(app: &AppHandle, section: &str) -> Result<PathBuf, String> {
    app.path()
        .executable_dir()
        .map(|path| path.join(".cache").join(section))
        .map_err(|error| format!("无法定位客户端安装目录: {error}"))
}
