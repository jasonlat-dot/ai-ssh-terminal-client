//! 独立连接测试：每次创建临时 HTTP/TLS 客户端，不读取活动远程身份，不操作 WebView。
//! 页面草稿是唯一的远程信任来源；测试不保存档案、不启动后端、不改变证书允许缓存。

use std::{error::Error, time::{Duration, Instant}};
use reqwest::{Certificate, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_HEALTH_BODY: usize = 64 * 1024;
/** 错误正文只读取前 8 KiB，展示最多 2048 个字符，不把整份错误页面带入 IPC。 */
const MAX_ERROR_BODY: usize = 8 * 1024;
const MAX_DETAIL_CHARS: usize = 2048;

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind { Builtin, Remote }

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CertificateTrust { System, Certificate }

/**
 * 一次测试的独立配置，与保存的连接档案无关。
 * backend_url：页面填写的根地址；kind：内置/远程；trust：系统/指定公开证书；
 * certificate_pem：仅指定证书模式使用的单张 PEM，绝不接受私钥或证书链。
 */
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionProbeRequest {
    backend_url: String,
    kind: ConnectionKind,
    trust: CertificateTrust,
    certificate_pem: Option<String>,
}

/** 基础存活结果及限长的失败响应摘要；不返回请求头或 TLS 内部错误链。 */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProbeResult {
    ok: bool,
    status: Option<String>,
    latency_ms: u64,
    message: Option<String>,
    /** 未收到 HTTP 响应（例如 TLS 握手失败）时为空。 */
    http_status: Option<u16>,
    /** 仅失败时提供服务器响应正文摘要；前端必须作为纯文本显示。 */
    response_body: Option<String>,
}

/** 内部失败结果保留已经收到的 HTTP 状态和正文，与“尚未建立连接”的失败区分。 */
struct ProbeFailure {
    message: String,
    http_status: Option<u16>,
    response_body: Option<String>,
}

impl From<String> for ProbeFailure {
    fn from(message: String) -> Self { Self { message, http_status: None, response_body: None } }
}

impl From<&str> for ProbeFailure {
    fn from(message: &str) -> Self { message.to_owned().into() }
}

/** 校验 IPC 参数；前端校验不能代替原生边界校验，也不能将远程回环地址当内置档案。 */
fn validate(request: &ConnectionProbeRequest) -> Result<(Url, Option<Certificate>), String> {
    if request.backend_url.len() > 4096 { return Err("后端地址过长。".into()); }
    let url = Url::parse(request.backend_url.trim()).map_err(|_| "后端地址格式无效。")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
    { return Err("后端地址必须是 HTTP/HTTPS 根地址，不能包含登录信息、查询参数或锚点。".into()); }
    let pem = request.certificate_pem.as_deref().unwrap_or_default().trim();
    if request.kind == ConnectionKind::Builtin {
        if !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            || request.trust != CertificateTrust::System || !pem.is_empty()
        { return Err("内置连接只能测试本机地址，不能携带远程证书配置。".into()); }
    }
    if request.trust == CertificateTrust::System {
        // 系统模式不接受隐藏的补充证书；也不会访问用户目录下的 local-backend.crt。
        if !pem.is_empty() { return Err("系统信任模式不能携带指定证书。".into()); }
        return Ok((url, None));
    }
    #[cfg(not(target_os = "windows"))]
    return Err("当前平台暂不支持指定服务器证书，请使用系统信任。".into());
    #[cfg(target_os = "windows")]
    {
        const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
        const END: &str = "-----END CERTIFICATE-----";
        if url.scheme() != "https" || pem.len() > 16_384 || !pem.starts_with(BEGIN)
            || !pem.ends_with(END) || pem.matches(BEGIN).count() != 1
            || pem.matches(END).count() != 1 || pem.contains("PRIVATE KEY")
        { return Err("请为 HTTPS 连接导入单张 PEM 服务器公开证书，不能导入私钥或证书链。".into()); }
        let certificate = Certificate::from_pem(pem.as_bytes())
            .map_err(|_| "公开证书内容无效，请检查是否为 PEM 格式。")?;
        Ok((url, Some(certificate)))
    }
}

/**
 * 创建仅属于本次测试的客户端。
 * @param url 已验证的目标地址，回环地址不通过系统代理绕路
 * @param certificate 本次草稿显式选择的证书（或内置身份快照），不写入系统证书库
 * @return 无 WebView 缓存、无共享 cookie、无共享连接池的临时客户端
 */
fn build_client(url: &Url, certificate: Option<Certificate>) -> Result<Client, String> {
    let mut builder = Client::builder()
        // 只加载 OS 根证书，不混入另一份内置公共根集合；不信任内置 Java 的自签证书。
        .tls_built_in_webpki_certs(false)
        .tls_built_in_native_certs(true)
        .connect_timeout(PROBE_TIMEOUT)
        .timeout(PROBE_TIMEOUT)
        // 无论采用哪种验证模式，都不让“测试 A”通过重定向变成“测试 B”。
        .redirect(reqwest::redirect::Policy::none());
    if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) {
        builder = builder.no_proxy();
    }
    if let Some(certificate) = certificate {
        // 仅增加此次选择的信任锚；主机名、有效期和 TLS 签名验证仍由 TLS 库执行。
        builder = builder.add_root_certificate(certificate);
    }
    builder.build().map_err(|_| "无法初始化独立连接测试，请检查系统根证书或所选公开证书。".into())
}

/** 把 TLS 与网络错误区分展示；完整错误链仅用于分类，不回显 URL/证书或写入日志。 */
fn request_error(error: &reqwest::Error, trust: CertificateTrust) -> String {
    if error.is_timeout() { return "连接测试超时（4 秒），请检查服务地址和运行状态。".into(); }
    let mut description = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source { description.push_str(&cause.to_string()); source = cause.source(); }
    let lower = description.to_ascii_lowercase();
    if lower.contains("certificate") || lower.contains("certnotvalid") || lower.contains("unknownissuer") {
        return if trust == CertificateTrust::System {
            "TLS 证书校验失败：证书可能不受系统信任、已过期或主机名不符。自签服务请选择“指定服务器自签证书”并导入公开证书。".into()
        } else {
            "TLS 证书校验失败：请检查所选公开证书是否与服务匹配，以及证书有效期和访问主机名。".into()
        };
    }
    if error.is_connect() { return "无法连接到此后端，请检查地址、端口及服务是否启动。".into(); }
    "连接测试失败，请检查 HTTPS/HTTP 协议与服务配置是否一致。".into()
}

/**
 * 分块读取响应前缀，不调用无限制的 response.text()/bytes()。
 * @param response 本次 HTTP 响应；丢弃超限部分后不会继续下载整份错误页面
 * @param limit 内存保留的最大字节数
 * @return 正文前缀及是否截断；流读取错误仍由调用方结合已知 HTTP 状态展示
 */
async fn read_body_prefix(response: &mut reqwest::Response, limit: usize) -> Result<(Vec<u8>, bool), reqwest::Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let remaining = limit.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() > remaining { return Ok((body, true)); }
    }
    Ok((body, false))
}

/**
 * 生成供用户查看的纯文本摘要，保留换行，过滤控制字符与双向文字控制符。
 * @param body 限长读取的原始字节；不是可信 HTML，不能被前端解释为页面
 * @param truncated 是否已在读取阶段截断；字符截断同样追加明确标记
 * @return 非空正文摘要；PEM 证书/私钥块不回显，摘要也不写日志或连接档案
 */
fn response_summary(body: &[u8], truncated: bool) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    if text.contains("-----BEGIN ") {
        return Some("响应包含 PEM 内容，已省略，请在服务端查看。".into());
    }
    let cleaned: String = text.chars().filter(|character| {
        (!character.is_control() || matches!(character, '\n' | '\r' | '\t'))
            && !matches!(character, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
    }).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() { return None; }
    let mut summary: String = cleaned.chars().take(MAX_DETAIL_CHARS).collect();
    if truncated || cleaned.chars().count() > MAX_DETAIL_CHARS { summary.push_str("\n…（响应正文已截断）"); }
    Some(summary)
}

/** 失败 HTTP 响应统一带上状态码和正文，避免“返回 400”掩盖真正原因。 */
fn http_failure(code: u16, message: String, body: &[u8], truncated: bool) -> ProbeFailure {
    ProbeFailure { message, http_status: Some(code), response_body: response_summary(body, truncated) }
}

/** 验证 HTTP 状态与有限长度的健康响应，错误正文作为不可信纯文本摘要返回。 */
async fn check_health(client: Client, url: Url, trust: CertificateTrust) -> Result<(String, u16), ProbeFailure> {
    // 保留 Nginx 根地址中已有的路径前缀，而不是用 /api/health 覆盖它。
    let target = format!("{}/api/health", url.as_str().trim_end_matches('/'));
    let mut response = client.get(target).header(reqwest::header::ACCEPT, "application/json")
        .send().await.map_err(|error| request_error(&error, trust))?;
    let http_status = response.status();
    let code = http_status.as_u16();
    let limit = if http_status.is_success() { MAX_HEALTH_BODY } else { MAX_ERROR_BODY };
    let (body, truncated) = read_body_prefix(&mut response, limit).await.map_err(|error| ProbeFailure {
        message: format!("健康检查返回 HTTP {code}，但响应正文读取失败：{}", request_error(&error, trust)),
        http_status: Some(code), response_body: None,
    })?;
    if http_status.is_redirection() {
        return Err(http_failure(code, "健康检查返回重定向，请填写最终后端根地址后重试。".into(), &body, truncated));
    }
    if !http_status.is_success() {
        let requires_tls = url.scheme() == "http" && code == 400
            && String::from_utf8_lossy(&body).to_ascii_lowercase().contains("this combination of host and port requires tls");
        let message = if requires_tls {
            "目标端口要求 HTTPS（HTTP 400），请将地址中的 http:// 改为 https:// 后重新测试。".into()
        } else { format!("健康检查返回 HTTP {code}，请查看下方服务器响应。") };
        return Err(http_failure(code, message, &body, truncated));
    }
    if truncated { return Err(http_failure(code, "健康检查响应过大，无法识别服务状态。".into(), &body, true)); }
    let payload: Value = serde_json::from_slice(&body)
        .map_err(|_| http_failure(code, "健康检查未返回有效 JSON。".into(), &body, false))?;
    let status = payload.get("status").and_then(Value::as_str)
        .ok_or_else(|| http_failure(code, "健康检查响应缺少 status 字段。".into(), &body, false))?;
    if status != "UP" { return Err(http_failure(code, "健康检查返回非 UP 状态。".into(), &body, false)); }
    Ok((status.into(), code))
}

/**
 * 独立测试页面草稿。
 * @param app 仅内置档案允许读取已登记的本机证书快照；远程测试不读取此状态
 * @param request 此次测试的地址、类型、验证方式和公开证书，不要求档案已保存/应用
 * @return TLS/HTTP/健康检查结果；不包含 CORS、登录鉴权或业务接口权限验证
 */
#[tauri::command]
pub async fn probe_backend_connection(app: AppHandle, request: ConnectionProbeRequest) -> Result<ConnectionProbeResult, String> {
    let started = Instant::now();
    let (url, mut certificate) = validate(&request)?;
    if request.kind == ConnectionKind::Builtin {
        certificate = crate::local_backend_tls::builtin_certificate_for_url(&app, &url);
    }
    let trust = request.trust;
    let probe = async move {
        let build_url = url.clone();
        // OS 根证书加载包含磁盘 IO，放入阻塞线程池，不能冻结窗口或异步执行器。
        let client = tauri::async_runtime::spawn_blocking(move || build_client(&build_url, certificate))
            .await.map_err(|_| "无法创建独立连接测试任务。".to_string())??;
        check_health(client, url, trust).await
    };
    // 限制整体耗时（包括客户端准备和响应读取），不是只限制 TCP 连接阶段。
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, probe).await
        .unwrap_or_else(|_| Err("连接测试超时（4 秒）。".into()));
    Ok(match outcome {
        Ok((status, code)) => ConnectionProbeResult {
            ok: true, status: Some(status), latency_ms: started.elapsed().as_millis() as u64,
            message: None, http_status: Some(code), response_body: None,
        },
        Err(failure) => ConnectionProbeResult {
            ok: false, status: None, latency_ms: started.elapsed().as_millis() as u64,
            message: Some(failure.message), http_status: failure.http_status, response_body: failure.response_body,
        },
    })
}
