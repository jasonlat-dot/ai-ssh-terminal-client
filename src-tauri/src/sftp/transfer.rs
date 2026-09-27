use super::*;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

pub(super) struct Job {
    root: PathBuf,
    upload: HashMap<String, PathBuf>,
    saved: Mutex<HashSet<String>>,
    pub(super) running: AtomicBool,
    pub stop: CancellationToken,
}
fn scan(
    selected: PathBuf,
    stop: CancellationToken,
) -> Result<(Vec<Value>, HashMap<String, PathBuf>)> {
    let top = selected
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::local("请选择一个文件或目录，不支持上传本地文件系统根目录"))?
        .to_owned();
    let mut queue = vec![(selected, top)];
    let mut items = vec![];
    let mut paths = HashMap::new();
    while let Some((file, relative)) = queue.pop() {
        if stop.is_cancelled() {
            return Err(Error::cancelled());
        }
        path::relative(&relative, false)?;
        let meta = std::fs::symlink_metadata(&file)?;
        if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
            return Err(Error::local(format!(
                "不支持符号链接或特殊文件：{relative}"
            )));
        }
        items.push(json!({"relativePath":relative,"kind":if meta.is_dir() { "DIRECTORY" } else { "FILE" },"size":if meta.is_file() { meta.len() } else { 0 }}));
        if items.len() > 100_000 {
            return Err(Error::local("本地清单超过 100000 个条目"));
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(&file)? {
                let entry = entry?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| Error::local("不支持非 Unicode 文件名"))?;
                queue.push((entry.path(), format!("{relative}/{name}")));
                if queue.len() + items.len() > 100_000 {
                    return Err(Error::local("本地清单超过 100000 个条目"));
                }
            }
        } else {
            paths.insert(relative, file);
        }
    }
    Ok((items, paths))
}
pub(super) async fn create(
    session: Arc<Session>,
    direction: &str,
    local: String,
    remote: String,
    conflict: &str,
) -> Result<()> {
    if !["UPLOAD", "DOWNLOAD"].contains(&direction)
        || !["FAIL", "SKIP", "REPLACE"].contains(&conflict)
    {
        return Err(Error::local("传输参数无效"));
    }

    // 后端重启会清空内存中的 SFTP 会话。先做一次不受 metadata 锁影响的短超时检查，
    // 避免扫描完成后才发现旧 sessionId 无效，也避免界面长期停在“正在创建上传任务”。
    session.ensure_server_session().await?;

    let selected = PathBuf::from(local);
    if std::fs::symlink_metadata(&selected)?
        .file_type()
        .is_symlink()
    {
        return Err(Error::local("不支持符号链接"));
    }
    let selected = std::fs::canonicalize(selected)?;
    let mut body = json!({"sftpSessionId":session.id,"direction":direction,"remotePath":remote,"conflict":conflict});
    let upload;
    let root;
    if direction == "UPLOAD" {
        root = selected
            .parent()
            .ok_or_else(|| Error::local("不能上传文件系统根目录"))?
            .to_path_buf();
        let stop = session.stop.clone();
        let (manifest, files) = tokio::task::spawn_blocking(move || scan(selected, stop))
            .await
            .map_err(|e| Error::local(e.to_string()))??;
        body["items"] = json!(manifest);
        upload = files;
    } else {
        if !selected.is_dir() {
            return Err(Error::local("下载目标必须是本地目录"));
        }
        root = selected;
        upload = HashMap::new();
    }
    let task: Task = {
        let _guard = session.metadata.lock().await;
        serde_json::from_value(session.json(Method::POST, "transfers", Some(body)).await?)?
    };
    session.event("task", serde_json::to_value(&task)?);
    let check = (|| {
        path::validate_manifest(&task.items, cfg!(windows))?;
        if direction == "DOWNLOAD" {
            for item in &task.items {
                let target = path::destination(&root, &item.relative_path)?;
                if target.exists() && !(item.kind == "DIRECTORY" && target.is_dir()) {
                    return Err(Error::local(format!(
                        "本地目标已存在，不会覆盖：{}",
                        target.display()
                    )));
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = check {
        let _ = session
            .json(
                Method::POST,
                &format!("transfers/{}/cancel", task.transfer_id),
                None,
            )
            .await;
        let _ = session.publish_task(&task.transfer_id).await;
        session.event(
            "error",
            json!({"transferId":task.transfer_id,"message":error.message}),
        );
        return Err(error);
    }
    let job = Arc::new(Job {
        root,
        upload,
        saved: Mutex::new(HashSet::new()),
        running: AtomicBool::new(false),
        stop: session.stop.child_token(),
    });
    session
        .jobs
        .lock()
        .unwrap()
        .insert(task.transfer_id.clone(), job.clone());
    run(session, task.transfer_id, job).await
}

struct Running<'a>(&'a AtomicBool);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
pub(super) async fn run(session: Arc<Session>, id: String, job: Arc<Job>) -> Result<()> {
    if job.running.swap(true, Ordering::SeqCst) {
        return Err(Error::local("任务仍在执行"));
    }
    let _running = Running(&job.running);
    let task = session.publish_task(&id).await?;
    if task.progress["status"] == "CANCELLED" || job.stop.is_cancelled() {
        return Err(Error::cancelled());
    }
    let items: Vec<Item> = task
        .items
        .iter()
        .filter(|item| !["COMPLETED", "SKIPPED", "CANCELLED"].contains(&item.status.as_str()))
        .cloned()
        .collect();
    let task = Arc::new(task);
    let work = futures_util::stream::iter(items)
        .map(|item| {
            let session = session.clone(); let job = job.clone(); let task = task.clone();
            async move {
                let result = tokio::select! {
                    _ = job.stop.cancelled() => Err(Error::cancelled()),
                    result = async {
                        let _slot = session.slots.acquire().await.map_err(|_| Error::cancelled())?;
                        execute(&session, &job, &task, &item).await
                    } => result,
                };
                if let Err(error) = &result {
                    session.event("error", json!({"transferId":task.transfer_id,"message":format!("{}：{}", item.relative_path, error.message)}));
                }
                let _ = session.publish_task(&task.transfer_id).await;
                result
            }
        }).buffer_unordered(2).collect::<Vec<_>>().await;
    session.publish_task(&id).await?;
    for result in work {
        result?;
    }
    Ok(())
}
async fn execute(session: &Session, job: &Job, task: &Task, item: &Item) -> Result<()> {
    // Never blindly repeat an ambiguous upload: inspect the authoritative item first.
    let latest = session.task(&task.transfer_id).await?;
    let current = latest
        .items
        .iter()
        .find(|i| i.item_id == item.item_id)
        .ok_or_else(|| Error::local("条目已失效"))?;
    if ["COMPLETED", "SKIPPED"].contains(&current.status.as_str()) {
        return Ok(());
    }
    if current.status == "RUNNING" {
        return Err(Error::local("服务端仍在处理此条目，请稍后查询状态"));
    }
    if task.direction == "DOWNLOAD" && job.saved.lock().unwrap().contains(&item.item_id) {
        return confirm(session, &task.transfer_id, &item.item_id, true).await;
    }
    if task.direction == "DOWNLOAD" && item.kind == "DIRECTORY" {
        let target = path::destination(&job.root, &item.relative_path)?;
        if let Err(error) = tokio::fs::create_dir_all(target).await {
            let _ = confirm(session, &task.transfer_id, &item.item_id, false).await;
            return Err(error.into());
        }
        job.saved.lock().unwrap().insert(item.item_id.clone());
        return confirm(session, &task.transfer_id, &item.item_id, true).await;
    }
    if item.kind != "FILE" {
        return Ok(());
    }
    if task.direction == "DOWNLOAD" && current.status == "SENT" {
        // A previous local save failed before confirmation; make the file retryable.
        confirm(session, &task.transfer_id, &item.item_id, false).await?;
    }
    // A 429 did not acquire the server's transfer slot. Back off, bounded and cancellable.
    for attempt in 0..6 {
        let result = if task.direction == "UPLOAD" {
            upload(session, job, task, item).await
        } else {
            download(session, job, task, item).await
        };
        if result.as_ref().err().is_some_and(|e| e.status == 429) && attempt < 5 {
            tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
            continue;
        }
        return result;
    }
    unreachable!()
}
async fn upload(session: &Session, job: &Job, task: &Task, item: &Item) -> Result<()> {
    let source = job
        .upload
        .get(&item.relative_path)
        .ok_or_else(|| Error::local("本地源文件记录不存在"))?;
    let checked = path::destination(&job.root, &item.relative_path)?;
    if checked != *source {
        return Err(Error::local("本地源文件路径变化"));
    }
    let file = tokio::fs::File::open(source).await?;
    let meta = file.metadata().await?;
    if !meta.is_file() || meta.len() != item.size {
        return Err(Error::local("本地源文件大小已变化，请重新创建任务"));
    }
    let route = format!(
        "transfers/{}/items/{}/content",
        task.transfer_id, item.item_id
    );
    let response = session
        .client
        .put(session.url(&route))
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", item.size)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
        .send()
        .await?;
    response_json(response).await?;
    let latest = session.task(&task.transfer_id).await?;
    if !latest
        .items
        .iter()
        .any(|i| i.item_id == item.item_id && i.status == "COMPLETED")
    {
        return Err(Error::local("上传尚未确认完成，请查询任务状态"));
    }
    Ok(())
}
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
async fn download(session: &Session, job: &Job, task: &Task, item: &Item) -> Result<()> {
    let target = path::destination(&job.root, &item.relative_path)?;
    if target.exists() {
        return Err(Error::local("本地文件已存在，不会覆盖"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| Error::local("下载路径无效"))?;
    tokio::fs::create_dir_all(parent).await?;
    path::destination(&job.root, &item.relative_path)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = TempFile(parent.join(format!(".sftp-{}-{nonce}.part", std::process::id())));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)
        .await?;
    let result = async {
        let route = format!(
            "transfers/{}/items/{}/content",
            task.transfer_id, item.item_id
        );
        let response = session.client.get(session.url(&route)).send().await?;
        if !response.status().is_success() {
            response_json(response).await?;
            return Err(Error::local("下载响应无效"));
        }
        let mut stream = response.bytes_stream();
        let mut bytes = 0u64;
        let mut last_event = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            bytes += chunk.len() as u64;
            if bytes > item.size {
                return Err(Error::local("下载长度超过清单大小"));
            }
            tokio::time::timeout(Duration::from_secs(120), file.write_all(&chunk))
                .await
                .map_err(|_| Error::local("本地写入长时间无进展"))??;
            if last_event.elapsed() >= Duration::from_millis(300) || bytes == item.size {
                session.event(
                    "local-progress",
                    json!({"transferId":task.transfer_id,"itemId":item.item_id,"bytes":bytes}),
                );
                last_event = std::time::Instant::now();
            }
        }
        if bytes != item.size {
            return Err(Error::local(format!(
                "下载长度不符：预期 {}，收到 {bytes}",
                item.size
            )));
        }
        file.flush().await?;
        file.sync_all().await?;
        wait_sent(session, &task.transfer_id, &item.item_id).await?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = result {
        if error.status != 429 {
            let _ = confirm(session, &task.transfer_id, &item.item_id, false).await;
        }
        return Err(error);
    }
    path::destination(&job.root, &item.relative_path)?;
    // hard_link creates a complete file atomically and fails if the destination exists.
    // Unlike rename on Unix it never replaces an existing user's file.
    if let Err(error) = tokio::fs::hard_link(&temp.0, &target).await {
        let _ = confirm(session, &task.transfer_id, &item.item_id, false).await;
        return Err(error.into());
    }
    job.saved.lock().unwrap().insert(item.item_id.clone());
    confirm(session, &task.transfer_id, &item.item_id, true).await
}
async fn wait_sent(session: &Session, id: &str, item_id: &str) -> Result<()> {
    for _ in 0..50 {
        let task = session.task(id).await?;
        let item = task
            .items
            .iter()
            .find(|i| i.item_id == item_id)
            .ok_or_else(|| Error::local("下载条目不存在"))?;
        match item.status.as_str() {
            "SENT" | "COMPLETED" => return Ok(()),
            "FAILED" | "CANCELLED" => {
                return Err(Error::local(
                    item.message.as_deref().unwrap_or("服务端下载失败或已取消"),
                ))
            }
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
    Err(Error::local("仍在等待服务端确认发送完成，请稍后重试"))
}
async fn confirm(session: &Session, id: &str, item_id: &str, saved: bool) -> Result<()> {
    for attempt in 0..5 {
        let result = session
            .json(
                Method::POST,
                &format!("transfers/{id}/items/{item_id}/confirm"),
                Some(json!({"saved":saved})),
            )
            .await;
        if result.as_ref().err().is_some_and(|e| e.status == 409) && attempt < 4 {
            let task = session.task(id).await?;
            if task
                .items
                .iter()
                .any(|i| i.item_id == item_id && i.status == "CANCELLED")
            {
                return Err(Error::cancelled());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        } else {
            return result.map(|_| ());
        }
    }
    unreachable!()
}
