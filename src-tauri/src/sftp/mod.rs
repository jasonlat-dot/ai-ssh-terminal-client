mod events;
mod path;
mod transfer;

use futures_util::StreamExt;
use axum::http::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Clone, Debug, Serialize)]
pub struct Error {
    pub message: String,
    pub code: String,
    pub status: u16,
}
impl Error {
    pub fn local(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "SFTP_LOCAL_ERROR".into(),
            status: 0,
        }
    }
    fn cancelled() -> Self {
        Self {
            message: "传输已取消".into(),
            code: "SFTP_CANCELLED".into(),
            status: 409,
        }
    }

    /// 后端重启后，原来的内存会话 ID 不会继续有效。
    fn session_expired() -> Self {
        Self {
            message: "工作区已重新初始化或文件管理会话已失效，请重新连接".into(),
            code: "SFTP_SESSION_EXPIRED".into(),
            status: 404,
        }
    }

    /// 会话检查无法连接后端时，返回可被前端识别的错误。
    fn backend_unavailable(message: impl Into<String>) -> Self {
        Self {
            message: format!("应用工作区不可用，文件管理会话需要重新连接：{}", message.into()),
            code: "SFTP_BACKEND_UNAVAILABLE".into(),
            status: 503,
        }
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::local(e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::local(e.to_string())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub item_id: String,
    pub relative_path: String,
    pub kind: String,
    pub size: u64,
    pub status: String,
    #[serde(default)]
    pub transferred_bytes: u64,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub transfer_id: String,
    pub sftp_session_id: String,
    pub direction: String,
    pub remote_path: String,
    pub progress: Value,
    pub items: Vec<Item>,
}
#[derive(Default)]
pub struct State {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
pub struct Session {
    id: String,
    services: Arc<shellpilot_server::services::Services>,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    stop: CancellationToken,
    closed_error: Mutex<Option<Error>>,
    slots: Semaphore,
    metadata: tokio::sync::Mutex<()>,
    jobs: Mutex<HashMap<String, Arc<transfer::Job>>>,
}
impl Session {
    fn event(&self, kind: &str, data: Value) {
        (self.emit)(json!({ "type": kind, "data": data }));
    }
    async fn json(&self, method: Method, route: &str, body: Option<Value>) -> Result<Value> {
        tokio::select! {
            _ = self.stop.cancelled() => Err(self.closed_error.lock().unwrap().clone().unwrap_or_else(Error::cancelled)),
            result = self.request_raw(method, route, body) => result,
        }
    }

    async fn request_raw(&self, method: Method, route: &str, body: Option<Value>) -> Result<Value> {
        local_json(&self.services, method, route, body.unwrap_or(Value::Null)).await
    }
    /// 在扫描本地文件、等待元数据操作锁之前，确认后端仍持有当前 SFTP 会话。
    ///
    /// 这项检查故意不获取 metadata 锁。后端重启时，旧目录请求可能仍在等待网络超时；
    /// 如果健康检查也排在该锁后面，新的上传操作就会表现为无请求、无错误地长时间等待。
    async fn ensure_server_session(&self) -> Result<()> {
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            self.request_raw(
                Method::GET,
                &format!("sessions/{}", self.id),
                None,
            ),
        )
        .await
        .map_err(|_| Error::backend_unavailable("会话检查超时"))?;

        match result {
            Ok(_) => Ok(()),
            Err(error) if error.status == 404 => Err(Error::session_expired()),
            Err(error) if error.status == 0 => Err(Error::backend_unavailable(error.message)),
            Err(error) => Err(error),
        }
    }
    async fn task(&self, id: &str) -> Result<Task> {
        Ok(serde_json::from_value(
            self.json(Method::GET, &format!("transfers/{id}"), None)
                .await?,
        )?)
    }
    async fn publish_task(&self, id: &str) -> Result<Task> {
        let task = self.task(id).await?;
        self.event("task", serde_json::to_value(&task)?);
        Ok(task)
    }
}

fn from_service(error: shellpilot_server::sftp::Error) -> Error {
    Error {
        message: error.message,
        code: error.code.into(),
        status: error.status.as_u16(),
    }
}
async fn local_json(
    services: &shellpilot_server::services::Services,
    method: Method,
    route: &str,
    body: Value,
) -> Result<Value> {
    if services.stop.is_cancelled() {
        return Err(Error::session_expired());
    }
    let parts = route.split('/').collect::<Vec<_>>();
    let string = |name: &str| {
        body[name]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::local("SFTP 参数无效"))
    };
    let manager = &services.sftp;
    macro_rules! data {
        ($v:expr) => {
            serde_json::to_value($v).map_err(Into::into)
        };
    }
    match (method.as_str(), parts.as_slice()) {
        ("GET", ["sessions", id]) => data!(manager.session_view(id).map_err(from_service)?),
        ("DELETE", ["sessions", id]) => {
            manager.close(id).map_err(from_service)?;
            Ok(Value::Null)
        }
        ("GET", ["sessions", id, "entries"]) => data!(manager
            .entries(id, body["path"].as_str())
            .await
            .map_err(from_service)?),
        ("DELETE", ["sessions", id, "entries"]) => {
            manager
                .change_entry(
                    id,
                    &string("path")?,
                    "delete",
                )
                .await
                .map_err(from_service)?;
            Ok(Value::Null)
        }
        ("POST", ["sessions", id, "directories"]) => {
            manager
                .change_entry(id, &string("path")?, "mkdir")
                .await
                .map_err(from_service)?;
            Ok(Value::Null)
        }
        ("POST", ["sessions", id, "files"]) => {
            manager
                .change_entry(id, &string("path")?, "file")
                .await
                .map_err(from_service)?;
            Ok(Value::Null)
        }
        ("GET", ["sessions", id, "transfers"]) => data!(manager.tasks(id).map_err(from_service)?),
        ("POST", ["transfers"]) => data!(manager
            .create_transfer(serde_json::from_value(body)?)
            .await
            .map_err(from_service)?),
        ("GET", ["transfers", id]) => data!(manager.transfer_view(id).map_err(from_service)?),
        ("POST", ["transfers", id, "cancel"]) => {
            manager.cancel(id).map_err(from_service)?;
            Ok(Value::Null)
        }
        ("POST", ["transfers", id, "items", item, "confirm"]) => {
            manager
                .confirm(
                    id,
                    item,
                    body["saved"]
                        .as_bool()
                        .ok_or_else(|| Error::local("确认参数无效"))?,
                )
                .map_err(from_service)?;
            Ok(Value::Null)
        }
        _ => Err(Error::local("不支持的本地 SFTP 操作")),
    }
}

impl State {
    fn get(&self, id: &str) -> Result<Arc<Session>> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(Error::session_expired)?;
        if session.stop.is_cancelled() {
            return Err(session.closed_error.lock().unwrap().clone().unwrap_or_else(Error::session_expired));
        }
        Ok(session)
    }
    pub async fn open_local(
        &self,
        services: Arc<shellpilot_server::services::Services>,
        request: shellpilot_server::sftp::model::OpenRequest,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Value> {
        self.open_terminal_local(services, request, None, emit).await
    }
    pub async fn open_terminal_local(
        &self,
        services: Arc<shellpilot_server::services::Services>,
        request: shellpilot_server::sftp::model::OpenRequest,
        terminal: Option<&str>,
        emit: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Value> {
        let opened = if let Some(terminal) = terminal {
            let access = services.terminals.file_access(terminal, &request.connection_id, "default")
                .map_err(|e| Error::local(e.to_string()))?;
            services.sftp.open_terminal(request, access).await
        } else { services.sftp.open(request).await }.map_err(from_service)?;
        let data = serde_json::to_value(&opened)?;
        let session = Arc::new(Session {
            id: opened.sftp_session_id.clone(),
            services,
            emit,
            stop: CancellationToken::new(),
            closed_error: Mutex::new(None),
            slots: Semaphore::new(2),
            metadata: tokio::sync::Mutex::new(()),
            jobs: Mutex::new(HashMap::new()),
        });
        self.sessions
            .lock()
            .unwrap()
            .insert(opened.sftp_session_id, session.clone());
        tokio::spawn(events::subscribe(session));
        Ok(data)
    }
    pub async fn close(&self, id: &str) -> Result<()> {
        // Expired sessions must still be removable; close is idempotent.
        let session = self.sessions.lock().unwrap().remove(id);
        let Some(session) = session else {
            return Ok(());
        };
        // Stop local writers immediately, even if the server is temporarily unreachable.
        session.stop.cancel();
        let result = session
            .request_raw(
                Method::DELETE,
                &format!("sessions/{id}"),
                None,
            )
            .await;
        // 无论后端是否可达，都必须移除 Tauri 内存中的会话，避免旧 sessionId 和进度订阅任务残留。
        match result {
            Ok(_) => Ok(()),
            Err(error) if error.status == 404 => Ok(()),
            Err(error) => Err(error),
        }
    }
    pub async fn entries(&self, id: &str, path: &str) -> Result<Value> {
        let session = self.get(id)?;
        let _guard = session.metadata.lock().await;
        session.json(Method::GET, &format!("sessions/{id}/entries"), Some(json!({"path":path}))).await
    }
    pub async fn mkdir(&self, id: &str, path: &str) -> Result<()> {
        let session = self.get(id)?;
        let _guard = session.metadata.lock().await;
        session
            .json(
                Method::POST,
                &format!("sessions/{id}/directories"),
                Some(json!({"path":path})),
            )
            .await?;
        Ok(())
    }

    pub async fn create_file(&self, id: &str, path: &str) -> Result<()> {
        let session = self.get(id)?;
        let _guard = session.metadata.lock().await;
        session
            .json(
                Method::POST,
                &format!("sessions/{id}/files"),
                Some(json!({"path":path})),
            )
            .await?;
        Ok(())
    }

    pub async fn delete_entry(&self, id: &str, path: &str) -> Result<()> {
        let session = self.get(id)?;
        let _guard = session.metadata.lock().await;
        session.json(Method::DELETE, &format!("sessions/{id}/entries"), Some(json!({"path":path}))).await?;
        Ok(())
    }
    pub async fn tasks(&self, id: &str) -> Result<Value> {
        let session = self.get(id)?;
        let snapshot = session
            .json(Method::GET, &format!("sessions/{id}/transfers"), None)
            .await?;
        if let Some(tasks) = snapshot.as_array() {
            session.jobs.lock().unwrap().retain(|id, job| {
                job.running.load(std::sync::atomic::Ordering::SeqCst)
                    || tasks
                        .iter()
                        .any(|task| task["transferId"].as_str() == Some(id.as_str()))
            });
        }
        Ok(snapshot)
    }
    pub async fn transfer(
        &self,
        id: &str,
        direction: &str,
        local: String,
        remote: String,
        conflict: &str,
    ) -> Result<()> {
        transfer::create(self.get(id)?, direction, local, remote, conflict).await
    }
    pub async fn retry(&self, id: &str, task_id: &str) -> Result<()> {
        let session = self.get(id)?;
        let job = session
            .jobs
            .lock()
            .unwrap()
            .get(task_id)
            .cloned()
            .ok_or_else(|| Error::local("本地任务记录已失效，请重新创建传输"))?;
        transfer::run(session, task_id.to_owned(), job).await
    }
    pub async fn cancel(&self, id: &str, task_id: &str) -> Result<()> {
        let session = self.get(id)?;
        if let Some(job) = session.jobs.lock().unwrap().get(task_id) {
            job.stop.cancel();
        }
        session
            .json(Method::POST, &format!("transfers/{task_id}/cancel"), None)
            .await?;
        session.publish_task(task_id).await?;
        Ok(())
    }
}

pub fn local_entries(path: Option<String>) -> Result<Value> {
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or_else(|| Error::local("无法读取用户主目录，请输入本地路径"))?,
        ),
    };
    let path = std::fs::canonicalize(path)?;
    let display_path = local_display_path(&path)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        let meta = std::fs::symlink_metadata(entry.path())?;
        let kind = if meta.file_type().is_symlink() {
            "SYMLINK"
        } else if meta.is_dir() {
            "DIRECTORY"
        } else if meta.is_file() {
            "FILE"
        } else {
            "OTHER"
        };
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::local("目录含非 Unicode 文件名"))?;
        entries.push(json!({"name":name,"path":local_display_path(&entry.path())?,"kind":kind,"size":if meta.is_file() { meta.len() } else { 0 },"modifiedAt":meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0),"permissions":""}));
        if entries.len() > 100_000 {
            return Err(Error::local("本地目录条目过多，请选择较小的目录"));
        }
    }
    entries.sort_by_key(|item| {
        (
            item["kind"] != "DIRECTORY",
            item["name"].as_str().unwrap_or("").to_lowercase(),
        )
    });
    Ok(
        json!({"path":display_path,"parent":path.parent().map(local_display_path).transpose()?,"roots":local_roots(),"entries":entries}),
    )
}

fn local_display_path(path: &Path) -> Result<String> {
    let value = path.to_str().ok_or_else(|| Error::local("路径编码无效"))?;
    #[cfg(windows)]
    {
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{unc}"));
        }
        if let Some(drive_path) = value.strip_prefix(r"\\?\") {
            return Ok(drive_path.to_string());
        }
    }
    Ok(value.to_string())
}

fn local_roots() -> Vec<String> {
    if cfg!(windows) {
        (b'A'..=b'Z')
            .map(|letter| format!("{}:\\", letter as char))
            .filter(|root| Path::new(root).exists())
            .collect()
    } else {
        vec!["/".to_string()]
    }
}

pub fn local_mkdir(parent: String, name: String) -> Result<()> {
    if name.contains('/') {
        return Err(Error::local("请输入单个目录名"));
    }
    let root = std::fs::canonicalize(parent)?;
    std::fs::create_dir(path::destination(&root, &name)?)?;
    Ok(())
}

pub fn local_create_file(parent: String, name: String) -> Result<()> {
    let root = std::fs::canonicalize(parent)?;
    let target = path::destination(&root, &name)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    Ok(())
}

pub fn local_delete(path: String) -> Result<()> {
    let target = std::path::PathBuf::from(path);
    let metadata = std::fs::symlink_metadata(&target)?;
    if metadata.file_type().is_symlink() {
        return Err(Error::local("不支持删除符号链接"));
    }
    if metadata.is_file() {
        std::fs::remove_file(target)?;
    } else if metadata.is_dir() {
        std::fs::remove_dir(target).map_err(|error| match error.kind() {
            std::io::ErrorKind::DirectoryNotEmpty => Error::local("目录不为空，仅支持删除空目录"),
            _ => error.into(),
        })?;
    } else {
        return Err(Error::local("只支持删除普通文件或空目录"));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod native_tests;
