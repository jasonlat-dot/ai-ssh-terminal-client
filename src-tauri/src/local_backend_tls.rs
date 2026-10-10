//! 本机后端证书固定信任：只信任用户数据目录导出的证书和当前后端回环端口。
//! 远程自签证书必须由用户显式提供公开证书，并限定于活动连接；不关闭校验或修改系统信任库。

use std::{collections::BTreeMap, fs, io, path::Path, sync::Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, PartialEq)]
struct LocalIdentity {
    port: u16,
    pem: String,
}

/** 远程连接自己的信任设置；None PEM 表示使用系统信任，不继承本机证书例外。 */
#[derive(Clone, PartialEq)]
struct RemoteIdentity {
    origin: String,
    pem: Option<String>,
}

impl LocalIdentity {
    /** 只允许 HTTPS 回环地址；路径可为健康检查、API、文件下载或 SSE。 */
    fn matches(&self, url: &reqwest::Url) -> bool {
        url.scheme() == "https"
            && url.port_or_known_default() == Some(self.port)
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none()
    }
}

/** 证书在启动后台线程读取；窗口线程的证书回调只读取内存，不做磁盘或网络 IO。 */
#[derive(Default)]
pub struct LocalBackendTlsState {
    /** 各本机端口独立保存身份，外部 IDEA 服务与内置服务不会互相覆盖。 */
    identities: Mutex<BTreeMap<u16, LocalIdentity>>,
    remote_connection: Mutex<Option<RemoteIdentity>>,
    /** 串行切换活动身份与 WebView 缓存，防止快速切换时旧配置覆盖新配置。 */
    remote_update: Mutex<()>,
    #[cfg(target_os = "windows")]
    installation_error: Mutex<Option<String>>,
}

/**
 * 切换活动连接的 TLS 信任，只接收公开 PEM，不接收服务器私钥或 key-store 密码。
 * backend_url 为空表示内置连接；远程即使是 localhost，也不继承内置后端的自动信任。
 * 证书变更/切回系统信任时清除 WebView 的旧允许决定；清理失败则拒绝切换。
 */
#[tauri::command]
pub async fn configure_backend_connection_tls(
    app: AppHandle, backend_url: Option<String>, certificate_pem: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> io::Result<()> {
        let state = app.state::<LocalBackendTlsState>();
        let _guard = state.remote_update.lock().map_err(|_| io::Error::other("连接切换锁已损坏"))?;
        let identity = match backend_url {
            None => {
                if certificate_pem.is_some() { return Err(io::Error::other("内置连接不能携带远程证书")); }
                None
            }
            Some(raw) => {
                let url = reqwest::Url::parse(&raw).map_err(io::Error::other)?;
                if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
                    return Err(io::Error::other("远程连接地址无效"));
                }
                if let Some(pem) = certificate_pem.as_ref() {
                    if url.scheme() != "https" || pem.len() > 16_384
                        || pem.matches("-----BEGIN CERTIFICATE-----").count() != 1
                        || pem.contains("PRIVATE KEY") {
                        return Err(io::Error::other("仅允许 HTTPS 连接使用单张公开 PEM 证书"));
                    }
                    reqwest::Certificate::from_pem(pem.as_bytes()).map_err(io::Error::other)?;
                    #[cfg(not(target_os = "windows"))]
                    return Err(io::Error::other("当前平台的 WebView 暂不支持单连接证书信任，请使用系统信任或正式证书"));
                    #[cfg(target_os = "windows")]
                    if let Some(error) = state.installation_error.lock().map_err(|_| io::Error::other("证书事件锁已损坏"))?.as_ref() {
                        return Err(io::Error::other(format!("WebView2 证书事件不可用：{error}")));
                    }
                }
                Some(RemoteIdentity { origin: url.origin().ascii_serialization(), pem: certificate_pem })
            }
        };
        let previous = {
            let mut active = state.remote_connection.lock().map_err(|_| io::Error::other("连接身份锁已损坏"))?;
            if *active == identity { return Ok(()); }
            std::mem::replace(&mut *active, identity)
        };
        #[cfg(target_os = "windows")]
        if let Err(error) = clear_cached_decisions(&app) {
            if let Ok(mut active) = state.remote_connection.lock() { *active = previous; }
            return Err(error);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = previous;
        Ok(())
    }).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

/** 返回请求可使用的公开证书；活动远程档案优先，系统验证模式不会回退到本机例外。 */
fn pem_for_url(app: &AppHandle, url: &reqwest::Url) -> Option<String> {
    let state = app.state::<LocalBackendTlsState>();
    let remote = state.remote_connection.lock().ok()?;
    if let Some(identity) = remote.as_ref().filter(|identity| identity.origin == url.origin().ascii_serialization()) {
        return identity.pem.clone();
    }
    drop(remote);
    let identities = state.identities.lock().ok()?;
    identities.get(&url.port_or_known_default()?).filter(|identity| identity.matches(url)).map(|identity| identity.pem.clone())
}

/**
 * 更新当前运行后端的信任身份。缺少证书时保持正常系统校验，不自动放行任何证书。
 * 自定义 CA 证书由系统正常验证；自定义自签证书应由用户自行信任，不套用默认身份。
 */
pub fn refresh(app: &AppHandle, directory: &Path, port: u16, enabled: bool) -> io::Result<()> {
    let state = app.state::<LocalBackendTlsState>();
    #[cfg(target_os = "windows")]
    if let Some(error) = state.installation_error.lock().map_err(|_| io::Error::other("证书事件状态锁已损坏"))?.as_ref() {
        if enabled {
            return Err(io::Error::other(format!("WebView2 本机证书校验不可用，请更新 WebView2 Runtime：{error}")));
        }
    }
    let path = directory.join("tls").join("local-backend.crt");
    let identity = if enabled && path.is_file() {
        let pem = fs::read_to_string(&path)?;
        // 提前解析，拒绝损坏文件；仅把公开证书存入客户端内存。
        reqwest::Certificate::from_pem(pem.as_bytes()).map_err(io::Error::other)?;
        Some(LocalIdentity { port, pem })
    } else if enabled {
        // 未找到此配置目录的证书，不抹掉外部连接已加载的正确身份。
        return Ok(());
    } else {
        None
    };
    let changed = {
        let mut current = state.identities.lock().map_err(|_| io::Error::other("本机证书状态锁已损坏"))?;
        let changed = current.get(&port) != identity.as_ref();
        if let Some(identity) = identity { current.insert(port, identity); }
        else { current.remove(&port); }
        changed
    };
    // WebView2 会缓存“主机+证书”的允许决定；换证书/端口/协议时必须清除旧决定。
    #[cfg(target_os = "windows")]
    if changed {
        if let Err(error) = clear_cached_decisions(app) {
            // 清理失败不能把新身份当作已完成，下次启动应重新尝试清理旧证书例外。
            if let Ok(mut identities) = state.identities.lock() {
                identities.remove(&port);
            }
            return Err(error);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = changed;
    if changed && enabled {
        eprintln!("本机后端 TLS 证书已加载：port={port} certificate={}", path.display());
    }
    Ok(())
}

/**
 * 后台线程等待证书例外缓存清理完成，running 发布后才会开始新的 HTTPS 请求。
 * COM 操作仍调度到窗口线程；等待不可从窗口线程调用，以免阻塞消息循环。
 */
#[cfg(target_os = "windows")]
fn clear_cached_decisions(app: &AppHandle) -> io::Result<()> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::ICoreWebView2_14, ClearServerCertificateErrorActionsCompletedHandler};
    use windows::core::Interface;
    let window = app.get_webview_window("main").ok_or_else(|| io::Error::other("主窗口不存在"))?;
    let (sender, receiver) = std::sync::mpsc::channel();
    window.with_webview(move |webview| {
        let completed = sender.clone();
        let result = unsafe {
            webview.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_14>())
                .and_then(|core| core.ClearServerCertificateErrorActions(
                    &ClearServerCertificateErrorActionsCompletedHandler::create(Box::new(move |status| {
                        let _ = completed.send(status.map_err(|error| error.to_string()));
                        Ok(())
                    }))))
        };
        if let Err(error) = result {
            let _ = sender.send(Err(error.to_string()));
        }
    }).map_err(io::Error::other)?;
    receiver.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(io::Error::other)?.map_err(io::Error::other)
}

/** 原生 SFTP HTTP 客户端也使用同一信任范围，不设置 danger_accept_invalid_certs。 */
pub fn certificate_for_url(app: &AppHandle, raw: &str) -> Option<reqwest::Certificate> {
    let url = reqwest::Url::parse(raw).ok()?;
    reqwest::Certificate::from_pem(pem_for_url(app, &url)?.as_bytes()).ok()
}

/**
 * 内置档案独立测试只读取该端口已经加载的本机身份快照。
 *
 * @param app 客户端句柄，只用于读取内存中的本机证书，不切换活动远程身份
 * @param url 待测试的内置 HTTPS 地址；仍须匹配回环主机和登记端口
 * @return 已加载的公开证书；没有匹配项时使用正常系统信任，不能任意寻找证书补位
 */
pub fn builtin_certificate_for_url(app: &AppHandle, url: &reqwest::Url) -> Option<reqwest::Certificate> {
    let state = app.state::<LocalBackendTlsState>();
    let identities = state.identities.lock().ok()?;
    let identity = identities.get(&url.port_or_known_default()?).filter(|identity| identity.matches(url))?;
    reqwest::Certificate::from_pem(identity.pem.as_bytes()).ok()
}

/** 在主窗口初始化时注册 WebView2 证书事件；COM 接口仅在窗口线程调用。 */
#[cfg(target_os = "windows")]
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, ServerCertificateErrorDetectedEventHandler, take_pwstr};
    use windows::core::{Interface, PWSTR};

    let handle = app.clone();
    let window = app.get_webview_window("main").ok_or_else(|| tauri::Error::AssetNotFound("main webview".into()))?;
    window.with_webview(move |webview| {
        let install_handler = || -> windows::core::Result<()> {
            unsafe {
                let core = webview.controller().CoreWebView2()?.cast::<ICoreWebView2_14>()?;
                let callback_app = handle.clone();
                let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()); };
                    let mut error_status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                    args.ErrorStatus(&mut error_status)?;
                    // 只豁免自签名的信任问题；过期、撤销、主机名不符等错误仍交给 WebView 拒绝。
                    if error_status != COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID {
                        return Ok(());
                    }
                    let mut uri = PWSTR::null();
                    args.RequestUri(&mut uri)?;
                    let raw = take_pwstr(uri);
                    let Ok(url) = reqwest::Url::parse(&raw) else { return Ok(()); };
                    let Some(pem) = pem_for_url(&callback_app, &url) else { return Ok(()); };
                    let certificate = args.ServerCertificate()?;
                    let mut encoded = PWSTR::null();
                    certificate.ToPemEncoding(&mut encoded)?;
                    let actual = take_pwstr(encoded);
                    let compact = |pem: &str| pem.chars().filter(|character| !character.is_whitespace()).collect::<String>();
                    let mut valid_from = 0.0;
                    let mut valid_to = 0.0;
                    certificate.ValidFrom(&mut valid_from)?;
                    certificate.ValidTo(&mut valid_to)?;
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_secs_f64()).unwrap_or(0.0);
                    // 证书内容、连接主机/端口及有效期必须匹配；只豁免用户明确选择的 CA 信任错误。
                    if compact(&actual) == compact(&pem) && now >= valid_from && now <= valid_to {
                        args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW)?;
                    }
                    Ok(())
                }));
                let mut token = 0;
                core.add_ServerCertificateErrorDetected(&handler, &mut token)?;
                // WebView2 持有事件处理器；窗口销毁时释放，无需泄漏 COM 对象保活。
                Ok(())
            }
        };
        if let Err(error) = install_handler() {
            if let Ok(mut stored) = handle.state::<LocalBackendTlsState>().installation_error.lock() {
                *stored = Some(error.to_string());
            }
        }
    })
}

/** 其他平台仍使用系统 TLS 信任，不提供全局跳过校验的降级方案。 */
#[cfg(not(target_os = "windows"))]
pub fn install(_: &AppHandle) -> tauri::Result<()> {
    Ok(())
}
