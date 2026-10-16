//! Native clipboard ingestion: no filesystem paths or original file bytes arrive from IPC.
use super::{service_error, Error, Result};
use serde_json::{json, Value};
use shellpilot_server::{files::UploadedFile, services::Services};
use std::{
    io::Cursor,
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::io::AsyncReadExt;

const MAX_BYTES: u64 = 20_000_000;
const EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "pdf", "txt", "log", "csv", "json", "yaml", "yml", "md",
];
pub(super) enum ClipboardInput {
    Files(Vec<PathBuf>),
    Image(Vec<u8>),
    Text(String),
    Empty,
}

pub(super) fn image_name(name: &str) -> bool {
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "webp"
    )
}
pub(super) async fn preview(services: &Services, file_id: &str) -> Result<String> {
    static WORKERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = WORKERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| Error::unavailable("图片预览已停止"))?;
    // File manager reads only the local user's records; no arbitrary path is accepted.
    let (asset, source) = services
        .files
        .open_attachment(file_id)
        .await
        .map_err(|_| Error::invalid("图片不存在或已清理"))?;
    if !image_name(&asset.file_name) || asset.size > MAX_BYTES {
        return Err(Error::invalid("此附件不能作为图片预览"));
    }
    let mut bytes = vec![];
    source
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error::invalid("图片读取失败"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        shellpilot_server::agent::attachments::image_preview(&bytes)
            .map(|v| v.0)
            .map_err(|_| Error::invalid("图片无法预览，请检查格式和尺寸"))
    })
    .await
    .map_err(|_| Error::unavailable("图片预览线程不可用"))?
}
pub(super) async fn uploaded_event(services: &Services, file: UploadedFile) -> Value {
    let url = if image_name(&file.file_name) {
        preview(services, &file.file_id).await.ok()
    } else {
        None
    };
    let mut value = serde_json::to_value(file).expect("file metadata serializes");
    if let Some(url) = url {
        value["previewUrl"] = json!(url);
    }
    json!({"type":"uploaded", "file":value})
}
pub(super) async fn upload_paths(
    services: &Services,
    paths: Vec<PathBuf>,
    limit: usize,
    budget: u64,
    mut emit: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    if paths.is_empty() || paths.len() > limit.min(4) {
        return Err(Error::invalid(
            "本次粘贴超过剩余附件数量，每条消息最多 4 个文件",
        ));
    }
    let budget = budget.min(MAX_BYTES);
    let mut sources = vec![];
    let mut total = 0u64;
    // Validate the entire selection and open handles before publishing any uploads.
    for path in paths {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| Error::invalid("文件名无效"))?
            .to_owned();
        let (_, ext) = shellpilot_server::files::model::file_name(&name)
            .map_err(|_| Error::invalid("聊天仅支持图片、PDF 和 UTF-8 文本"))?;
        if !EXTENSIONS.contains(&ext.as_str()) {
            return Err(Error::invalid(
                "聊天仅支持图片、PDF 和 UTF-8 文本，暂不支持 Office 文档",
            ));
        }
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| Error::invalid("无法打开复制的文件"))?;
        let metadata = file
            .metadata()
            .await
            .map_err(|_| Error::invalid("无法读取复制的文件"))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(Error::invalid("请复制普通文件，不能附加文件夹或空文件"));
        }
        total = total.saturating_add(metadata.len());
        if total > budget {
            return Err(Error::invalid("附件原始大小合计不能超过 20 MB"));
        }
        sources.push((uuid::Uuid::new_v4().to_string(), name, metadata.len(), file));
    }
    for (id, name, size, _) in &sources {
        emit(json!({"type":"preparing","id":id,"fileName":name,"size":size}))?;
    }
    for (id, name, _, file) in sources {
        if services.stop.is_cancelled() {
            return Err(Error::unavailable("服务已停止"));
        }
        let file = services
            .files
            .clone()
            .upload_reader(name, String::new(), file.take(MAX_BYTES + 1))
            .await
            .map_err(|_| Error::invalid("复制的文件上传失败，请检查附件存储"))?;
        let mut event = uploaded_event(services, file).await;
        event["id"] = json!(id);
        emit(event)?;
    }
    Ok(())
}
pub(super) async fn upload_image(
    services: &Services,
    bytes: Vec<u8>,
    limit: usize,
    budget: u64,
    mut emit: impl FnMut(Value) -> Result<()>,
) -> Result<()> {
    if limit == 0 {
        return Err(Error::invalid("每条消息最多附加 4 个文件"));
    }
    if bytes.len() as u64 > budget.min(MAX_BYTES) {
        return Err(Error::invalid("附件原始大小合计不能超过 20 MB"));
    }
    let name = format!("粘贴图片-{}.png", uuid::Uuid::new_v4().simple());
    let id = uuid::Uuid::new_v4().to_string();
    emit(json!({"type":"preparing","id":id,"fileName":name,"size":bytes.len()}))?;
    let file = match services
        .files
        .clone()
        .upload_reader(name, String::new(), Cursor::new(bytes))
        .await
    {
        Ok(file) => file,
        Err(error) => return Err(service_error(error).await),
    };
    let mut event = uploaded_event(services, file).await;
    event["id"] = json!(id);
    emit(event)
}

pub(super) fn read(app: &AppHandle, limit: usize) -> Result<ClipboardInput> {
    let paths = clipboard_paths(limit)?;
    if !paths.is_empty() {
        return Ok(ClipboardInput::Files(paths));
    }
    if let Ok(image) = app.clipboard().read_image() {
        let bytes = encode_clipboard_image(image.width(), image.height(), image.rgba())?;
        return Ok(ClipboardInput::Image(bytes));
    }
    if let Ok(text) = app.clipboard().read_text() {
        return Ok(ClipboardInput::Text(text));
    }
    Ok(ClipboardInput::Empty)
}
pub(super) fn encode_clipboard_image(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let size = u64::from(width) * u64::from(height) * 4;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || size > 128 * 1024 * 1024
        || rgba.len() as u64 != size
    {
        return Err(Error::invalid("剪贴板图片尺寸过大或内容无效"));
    }
    let image = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| Error::invalid("剪贴板图片无效"))?;
    let mut output = Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| Error::invalid("剪贴板图片转换失败"))?;
    let bytes = output.into_inner();
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Error::invalid("剪贴板图片超过 20 MB"));
    }
    Ok(bytes)
}
#[cfg(windows)]
fn clipboard_paths(limit: usize) -> Result<Vec<PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::{
        System::DataExchange::{
            CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        },
        UI::Shell::{DragQueryFileW, HDROP},
    };
    // CF_HDROP is the OS-owned list produced by Explorer's Copy command.
    const CF_HDROP: u32 = 15;
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() {
            return Ok(vec![]);
        }
        OpenClipboard(None).map_err(|_| Error::invalid("剪贴板正在使用，请重试粘贴"))?;
        struct Close;
        impl Drop for Close {
            fn drop(&mut self) {
                unsafe {
                    let _ = CloseClipboard();
                }
            }
        }
        let _close = Close;
        let handle =
            GetClipboardData(CF_HDROP).map_err(|_| Error::invalid("无法读取复制的文件"))?;
        let drop = HDROP(handle.0);
        let count = DragQueryFileW(drop, u32::MAX, None);
        if count == 0 || count as usize > limit.min(4) {
            return Err(Error::invalid(
                "本次粘贴超过剩余附件数量，每条消息最多 4 个文件",
            ));
        }
        let mut paths = vec![];
        for index in 0..count {
            let len = DragQueryFileW(drop, index, None);
            if len == 0 || len > 32767 {
                return Err(Error::invalid("复制的文件路径无效"));
            }
            let mut path = vec![0u16; len as usize + 1];
            if DragQueryFileW(drop, index, Some(&mut path)) != len {
                return Err(Error::invalid("复制的文件路径已变化，请重试"));
            }
            paths.push(PathBuf::from(std::ffi::OsString::from_wide(
                &path[..len as usize],
            )));
        }
        Ok(paths)
    }
}
#[cfg(not(windows))]
fn clipboard_paths(_limit: usize) -> Result<Vec<PathBuf>> {
    Ok(vec![])
}
