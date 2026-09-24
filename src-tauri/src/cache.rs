use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn cache_directory(app: &AppHandle, section: &str) -> Result<PathBuf, String> {
    if let Ok(path) = app.path().executable_dir() {
        return Ok(path.join(".cache").join(section));
    }

    // `tauri dev` does not expose an executable directory on every platform.
    // Keep development data beside the checked-out project in that case.
    if cfg!(debug_assertions) {
        return std::env::current_dir()
            .map(|path| path.join(".cache").join(section))
            .map_err(|error| format!("无法定位开发缓存目录: {error}"));
    }

    // Some packaged runtimes also cannot resolve the executable directory.
    // Their platform application-data directory is the last writable fallback.
    app.path()
        .app_data_dir()
        .map(|path| path.join(".cache").join(section))
        .map_err(|error| format!("无法定位客户端缓存目录: {error}"))
}
