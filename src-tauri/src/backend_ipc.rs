//! Desktop adapter: calls application services directly, with no loopback HTTP requests.
#[path = "attachment_input.rs"]
mod attachment_input;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shellpilot_server::services::Services;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Serialize)]
pub struct Error {
    pub message: String,
    pub code: String,
    pub status: u16,
}
impl Error {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "S0002".into(),
            status: 400,
        }
    }
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "BACKEND_UNAVAILABLE".into(),
            status: 503,
        }
    }
}
type Result<T> = std::result::Result<T, Error>;
pub async fn service_error(error: impl IntoResponse) -> Error {
    let response = error.into_response();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 16384)
        .await
        .unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    Error {
        status,
        code: value["code"].as_str().unwrap_or("SERVER_ERROR_001").into(),
        message: value["info"].as_str().unwrap_or("服务操作失败").into(),
    }
}
fn value<T: Serialize>(data: T) -> Result<Value> {
    serde_json::to_value(data).map_err(|_| Error::invalid("响应序列化失败"))
}
fn agent_error(error: shellpilot_server::agent::chat::Error) -> Error {
    Error {
        message: error.to_string(),
        code: error.code().into(),
        status: error.status(),
    }
}
fn text<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 256 * 1024)
        .ok_or_else(|| Error::invalid(format!("缺少或无效的 {name}")))
}
fn memory_view(params: &Value) -> Result<shellpilot_server::agent::memory::View> {
    serde_json::from_value(json!({
        "agentId":params.get("agentId").cloned().unwrap_or(json!("")),
        "sessionId":params.get("sessionId").cloned().unwrap_or(json!("")),
        "projectId":params.get("projectId").cloned().unwrap_or(json!("")),
    }))
    .map_err(|_| Error::invalid("记忆管理范围无效"))
}
fn number(params: &Value, name: &str, default: u64) -> Result<u64> {
    if params[name].is_null() {
        return Ok(default);
    }
    params[name]
        .as_u64()
        .or_else(|| params[name].as_str().and_then(|v| v.parse().ok()))
        .ok_or_else(|| Error::invalid("历史分页参数无效"))
}
async fn db<T: Send + 'static>(
    services: &Services,
    action: impl FnOnce(
            &shellpilot_server::store::Store,
        ) -> std::result::Result<T, shellpilot_server::error::Error>
        + Send
        + 'static,
) -> Result<T> {
    let store = services.store.clone();
    match tokio::task::spawn_blocking(move || action(&store))
        .await
        .map_err(|_| Error::unavailable("数据库线程不可用"))?
    {
        Ok(value) => Ok(value),
        Err(error) => Err(service_error(error).await),
    }
}

async fn models<T: Send + 'static>(
    services: &Services,
    action: impl FnOnce(
            shellpilot_server::agent::provider::ModelRepository,
        ) -> shellpilot_server::agent::provider::Result<T>
        + Send
        + 'static,
) -> Result<T> {
    let repository =
        shellpilot_server::agent::provider::ModelRepository::new(services.store.clone());
    tokio::task::spawn_blocking(move || action(repository))
        .await
        .map_err(|_| Error::unavailable("模型配置线程不可用"))?
        .map_err(|e| {
            use shellpilot_server::agent::provider::ModelError;
            let (status, code) = match e {
                ModelError::Invalid(_) => (400, "MODEL_CONFIG_INVALID"),
                ModelError::Stale => (409, "MODEL_CONFIG_CHANGED"),
                ModelError::NotFound => (404, "MODEL_CONFIG_NOT_FOUND"),
                ModelError::Credentials => (500, "MODEL_CREDENTIALS"),
                _ => (500, "MODEL_CONFIG_FAILED"),
            };
            Error {
                message: e.to_string(),
                code: code.into(),
                status,
            }
        })
}

pub async fn dispatch(
    services: Arc<Services>,
    endpoint: &str,
    method: &str,
    body: Value,
    params: Value,
) -> Result<Value> {
    if services.stop.is_cancelled() {
        return Err(Error::unavailable("工作区已停止，请重新初始化"));
    }
    macro_rules! run {
        ($operation:expr) => {
            match $operation {
                Ok(v) => value(v),
                Err(e) => Err(service_error(e).await),
            }
        };
    }
    match (method, endpoint) {
        ("GET", "agent/extensions_settings") => value(services.agent.extension_settings(text(&params,"userId")?,None).map_err(|e|Error::invalid(e.to_string()))?),
        ("POST", "agent/extensions_settings") => {
            let settings=serde_json::from_value(json!({"revision":body["revision"],"config":body["config"]})).map_err(|_|Error::invalid("扩展设置无效"))?;
            let scope = body.get("scope")
                .map(|scope| serde_json::from_value::<shellpilot_server::agent::extensions::config::SaveScope>(scope.clone()))
                .transpose().map_err(|_| Error::invalid("扩展设置保存范围无效"))?;
            let user = text(&body, "userId")?;
            let result = match scope {
                Some(scope) => services.agent.save_extension_section(user, settings, scope),
                None => services.agent.extension_settings(user, Some(settings)),
            };
            value(result.map_err(|e|Error::invalid(e.to_string()))?)
        },
        ("GET", "agent/extensions_requests") => value(services.agent.extension_requests(text(&params,"agentId")?.into(),text(&params,"userId")?.into(),text(&params,"sessionId")?.into()).await.map_err(agent_error)?),
        ("POST", "agent/extensions_decision") => {
            services.agent.extension_decision(text(&body,"agentId")?.into(),text(&body,"userId")?.into(),text(&body,"sessionId")?.into(),text(&body,"id")?.into(),body["allow"].as_bool().ok_or_else(||Error::invalid("审批决定无效"))?).await.map_err(agent_error)?;
            Ok(json!(true))
        },
        ("GET", "agent/models") => {
            let user = text(&params, "userId")?.to_owned();
            value(models(&services, move |r| r.list(&user)).await?)
        }
        ("POST", "agent/models") => {
            let user = text(&body, "userId")?.to_owned();
            let id = text(&body, "id")?.to_owned();
            let revision = body["revision"]
                .as_u64()
                .ok_or_else(|| Error::invalid("模型版本无效"))?;
            let update = serde_json::from_value(body["update"].clone())
                .map_err(|_| Error::invalid("模型配置参数无效"))?;
            let name = match &body["displayName"] {
                Value::Null => None,
                Value::String(name) => Some(name.clone()),
                _ => return Err(Error::invalid("配置名称无效")),
            };
            value(
                models(&services, move |r| {
                    r.save_named(&id, &user, revision, update, name.as_deref())
                })
                .await?,
            )
        }
        ("DELETE", "agent/models") => {
            let user = text(&body, "userId")?.to_owned();
            let id = text(&body, "id")?.to_owned();
            let revision = body["revision"]
                .as_u64()
                .ok_or_else(|| Error::invalid("模型版本无效"))?;
            models(&services, move |r| r.delete(&id, &user, revision)).await?;
            Ok(json!(true))
        }
        ("GET", "agent/query_ai_agent_config_list") => value(
            services
                .agent
                .list(params["userId"].as_str().unwrap_or("default").to_owned())
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/create_session") => {
            let policy = body.get("approvalMode")
                .map(|mode| serde_json::from_value(mode.clone()))
                .transpose()
                .map_err(|_| Error::invalid("策略无效"))?;
            let session = services
                .agent
                .create_general_session_with_policy(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    policy,
                )
                .await
                .map_err(agent_error)?;
            Ok(json!({"sessionId":session.id}))
        }
        ("POST", "agent/server_scope") => value(
            services
                .agent
                .server_scope(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "rootId")?.into(),
                    text(&body, "terminalSessionId")?.into(),
                    body["newTask"].as_bool().unwrap_or(false),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/scopes") => value(
            services
                .agent
                .scopes(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "rootId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/projects") => value(
            services
                .agent
                .projects(text(&params, "userId")?.into())
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/create_project") => value(
            services
                .agent
                .create_project(
                    text(&body, "userId")?.into(),
                    text(&body, "name")?.into(),
                    text(&body, "connectionId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/project_chats") => value(
            services
                .agent
                .project_chats(
                    text(&params, "userId")?.into(),
                    params["projectId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned),
                    params["after"].as_str().unwrap_or("").into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/rename_chat") => {
            services
                .agent
                .rename_chat(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "sessionId")?.into(),
                    text(&body, "title")?.into(),
                )
                .await
                .map_err(agent_error)?;
            Ok(json!(null))
        }
        ("POST", "agent/delete_chat") => {
            services
                .agent
                .delete_chat(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "sessionId")?.into(),
                )
                .await
                .map_err(agent_error)?;
            Ok(json!(null))
        }
        ("POST", "agent/delete_project") => {
            services
                .agent
                .delete_project(
                    text(&body, "userId")?.into(),
                    text(&body, "projectId")?.into(),
                )
                .await
                .map_err(agent_error)?;
            Ok(json!(null))
        }
        ("POST", "agent/project_terminal") => value(
            services
                .agent
                .project_terminal(
                    text(&body, "userId")?.into(),
                    text(&body, "projectId")?.into(),
                    text(&body, "terminalSessionId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/project_chat") => value(
            services
                .agent
                .project_chat(
                    text(&body, "userId")?.into(),
                    text(&body, "projectId")?.into(),
                    text(&body, "agentId")?.into(),
                    text(&body, "terminalSessionId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/execution_bind") => value(
            services
                .agent
                .bind_execution(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "sessionId")?.into(),
                    text(&body, "terminalSessionId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/execution_requests") => value(
            services
                .agent
                .execution_requests(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                    params["after"].as_str().unwrap_or("").into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/execution_decision") => {
            services
                .agent
                .execution_decision(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "sessionId")?.into(),
                    text(&body, "id")?.into(),
                    text(&body, "action")?.into(),
                )
                .await
                .map_err(agent_error)?;
            Ok(json!(true))
        }
        ("GET", "agent/execution_policy") => value(
            services
                .agent
                .execution_policy(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                    None,
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/execution_policy") => {
            let revision = body["revision"]
                .as_u64()
                .ok_or_else(|| Error::invalid("策略版本无效"))?;
            let mode = serde_json::from_value(body["mode"].clone())
                .map_err(|_| Error::invalid("策略无效"))?;
            value(
                services
                    .agent
                    .execution_policy(
                        text(&body, "agentId")?.into(),
                        text(&body, "userId")?.into(),
                        text(&body, "sessionId")?.into(),
                        Some((revision, mode)),
                    )
                    .await
                    .map_err(agent_error)?,
            )
        }
        ("GET", "agent/execution_output") => value(
            services
                .agent
                .execution_output(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                    text(&params, "outputId")?.into(),
                    number(&params, "offset", 0)?,
                    number(&params, "limit", 4096)?
                        .try_into()
                        .map_err(|_| Error::invalid("输出范围无效"))?,
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/steer") => value(
            services
                .agent
                .steer(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "sessionId")?.into(),
                    text(&body, "expectedRequestId")?.into(),
                    text(&body, "id")?.into(),
                    text(&body, "message")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/stop_chat") => value(
            services
                .agent
                .stop_request(
                    text(&body, "agentId")?.into(),
                    text(&body, "userId")?.into(),
                    text(&body, "sessionId")?.into(),
                    body["requestId"].as_str().map(str::to_owned),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/context_status") => value(
            services
                .agent
                .context_status(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/compact_context") => value(
            services.agent.compact_context(
                text(&body, "agentId")?.into(),
                text(&body, "userId")?.into(),
                text(&body, "sessionId")?.into(),
                &services.stop,
            ).await.map_err(agent_error)?,
        ),
        ("GET", "agent/memories") => value(
            services
                .agent
                .memories(text(&params, "userId")?.into(), memory_view(&params)?)
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/memories") => {
            let input = serde_json::from_value(body["memory"].clone())
                .map_err(|_| Error::invalid("记忆内容格式无效"))?;
            value(
                services
                    .agent
                    .save_memory(text(&body, "userId")?.into(), memory_view(&body)?, input)
                    .await
                    .map_err(agent_error)?,
            )
        }
        ("DELETE", "agent/memories") => {
            services
                .agent
                .delete_memory(
                    text(&body, "userId")?.into(),
                    memory_view(&body)?,
                    text(&body, "id")?.into(),
                    number(&body, "revision", 0)?,
                )
                .await
                .map_err(agent_error)?;
            Ok(json!(null))
        }
        ("GET", "agent/attachment") => value(
            services
                .agent
                .attachment(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                    text(&params, "fileId")?.into(),
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/chat_history") => value(
            services
                .agent
                .history(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                    number(&params, "after", 0)?,
                    number(&params, "limit", 20)?
                        .try_into()
                        .map_err(|_| Error::invalid("历史分页参数无效"))?,
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/session_list") => value(
            services
                .agent
                .sessions(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    params["after"].as_str().unwrap_or("").into(),
                    number(&params, "limit", 20)?
                        .try_into()
                        .map_err(|_| Error::invalid("历史分页参数无效"))?,
                )
                .await
                .map_err(agent_error)?,
        ),
        ("GET", "agent/events") => value(
            services
                .agent
                .events(
                    text(&params, "agentId")?.into(),
                    text(&params, "userId")?.into(),
                    text(&params, "sessionId")?.into(),
                    number(&params, "after", 0)?,
                    number(&params, "limit", 50)?
                        .try_into()
                        .map_err(|_| Error::invalid("历史分页参数无效"))?,
                )
                .await
                .map_err(agent_error)?,
        ),
        ("POST", "agent/chat_stream") => Err(Error {
            message: "流式聊天请使用应用内部 Channel".into(),
            code: "AGENT_CHANNEL_REQUIRED".into(),
            status: 400,
        }),
        ("GET", "health") => Ok(json!({"status":"UP","checkedAt":chrono::Utc::now()})),
        ("GET", "ssh/connection_list") => {
            let user = params["userId"].as_str().unwrap_or("default").to_owned();
            value(db(&services, move |s| s.list(&user)).await?)
        }
        ("GET", "ssh/get_connection") => {
            let id = text(&params, "connectionId")?.to_owned();
            value(db(&services, move |s| s.get(&id)).await?)
        }
        ("POST", "ssh/create_connection") => {
            let request =
                serde_json::from_value(body).map_err(|_| Error::invalid("连接参数无效"))?;
            value(db(&services, move |s| s.save(request, false)).await?)
        }
        ("POST", "ssh/update_connection") => run!(
            services
                .terminals
                .update_connection(
                    serde_json::from_value(body).map_err(|_| Error::invalid("连接参数无效"))?
                )
                .await
        ),
        ("POST", "ssh/delete_connection") => run!(
            services
                .terminals
                .delete_connection(text(&params, "connectionId")?.to_owned())
                .await
        ),
        ("POST", "ssh/terminal/connect") => run!(
            services
                .terminals
                .connect(serde_json::from_value(body).map_err(|_| Error::invalid("连接参数无效"))?)
                .await
        ),
        ("POST", "ssh/terminal/cancel_connect") => run!(services
            .terminals
            .cancel(text(&params, "connectionId")?, text(&params, "requestId")?)),
        ("GET", "ssh/terminal/connected") => {
            value(services.terminals.connected(text(&params, "sessionId")?))
        }
        ("POST", "ssh/terminal/write") => run!(
            services
                .terminals
                .write(text(&body, "sessionId")?, text(&body, "input")?.to_owned())
                .await
        ),
        ("POST", "ssh/terminal/resize") => {
            let cols = body["cols"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| Error::invalid("列数无效"))?;
            let rows = body["rows"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| Error::invalid("行数无效"))?;
            run!(
                services
                    .terminals
                    .resize(text(&body, "sessionId")?, cols, rows)
                    .await
            )
        }
        ("POST", "ssh/terminal/close") => {
            services.terminals.close(text(&params, "sessionId")?);
            Ok(Value::Null)
        }
        ("GET", "files") => run!(
            services
                .files
                .list(
                    params["offset"]
                        .as_str()
                        .unwrap_or("0")
                        .parse()
                        .map_err(|_| Error::invalid("分页参数无效"))?
                )
                .await
        ),
        ("GET", "files/storage") => run!(services.files.stats().await),
        ("GET", route) if route.starts_with("files/") => {
            run!(services.files.metadata(&route[6..]).await)
        }
        ("DELETE", route) if route.starts_with("files/") => {
            run!(services.files.delete(&route[6..]).await)
        }
        _ => Err(Error {
            message: "该功能尚未接入 Rust 工作区".into(),
            code: "FEATURE_NOT_MIGRATED".into(),
            status: 501,
        }),
    }
}

struct Subscription {
    stop: CancellationToken,
    ack: tokio::sync::Notify,
    sequence: std::sync::atomic::AtomicU64,
    acknowledged: std::sync::atomic::AtomicU64,
}
#[derive(Default)]
pub struct IpcState {
    operations: Mutex<HashMap<String, (CancellationToken, Instant)>>,
    streams: Mutex<HashMap<String, Arc<Subscription>>>,
}
struct AgentSubscriptionGuard<'a> {
    state: &'a IpcState,
    id: String,
    subscription: Arc<Subscription>,
}
impl Drop for AgentSubscriptionGuard<'_> {
    fn drop(&mut self) {
        self.subscription.stop.cancel();
        let mut streams = self.state.streams.lock().unwrap();
        if streams
            .get(&self.id)
            .is_some_and(|stream| Arc::ptr_eq(stream, &self.subscription))
        {
            streams.remove(&self.id);
            self.state.operations.lock().unwrap().remove(&self.id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JsonRequest {
    request_id: String,
    endpoint: String,
    method: String,
    body: Value,
    params: Value,
    backend_url: String,
}

#[tauri::command]
pub async fn builtin_request(
    app: AppHandle,
    state: State<'_, IpcState>,
    request: JsonRequest,
) -> Result<Value> {
    let JsonRequest {
        request_id,
        endpoint,
        method,
        body,
        params,
        backend_url,
    } = request;
    let services = services_for_url(&app, &backend_url)?;
    let token = {
        let mut ops = state.operations.lock().unwrap();
        ops.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(300));
        if ops.len() >= 512 {
            return Err(Error::unavailable("本地请求过多"));
        }
        ops.entry(request_id.clone())
            .or_insert_with(|| (CancellationToken::new(), Instant::now()))
            .0
            .clone()
    };
    let result = tokio::select! { biased; _=token.cancelled()=>Err(Error {message:"请求已取消，操作结果可能需要核实".into(),code:"REQUEST_CANCELLED".into(),status:409}), result=dispatch(services,&endpoint,&method,body,params)=>result };
    state.operations.lock().unwrap().remove(&request_id);
    result
}
pub fn services_for_url(app: &AppHandle, backend_url: &str) -> Result<Arc<Services>> {
    let state = app.state::<crate::bundled_backend::BundledBackendState>();
    let status = crate::bundled_backend::bundled_backend_status(state);
    if status.backend_url.as_deref() != Some(backend_url.trim_end_matches('/'))
        || status.status != "running"
    {
        return Err(Error::unavailable("工作区已重新初始化，请重新连接"));
    }
    crate::bundled_backend::services(app, backend_url.trim_end_matches('/'))
        .map_err(Error::unavailable)
}
#[tauri::command]
pub fn builtin_cancel(state: State<'_, IpcState>, request_id: String) {
    // Streams may live longer than the short-lived cancellation receipts.
    if let Some(stream) = state.streams.lock().unwrap().get(&request_id) {
        stream.stop.cancel();
    }
    let mut ops = state.operations.lock().unwrap();
    ops.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(300));
    if ops.len() < 512 {
        ops.entry(request_id)
            .or_insert_with(|| (CancellationToken::new(), Instant::now()))
            .0
            .cancel();
    }
}
#[tauri::command]
pub fn builtin_terminal_ack(state: State<'_, IpcState>, stream_id: String, sequence: u64) {
    use std::sync::atomic::Ordering;
    if let Some(stream) = state.streams.lock().unwrap().get(&stream_id) {
        if stream.sequence.load(Ordering::SeqCst) == sequence {
            stream.acknowledged.store(sequence, Ordering::SeqCst);
            stream.ack.notify_one();
        }
    }
}
#[tauri::command]
pub fn builtin_agent_ack(state: State<'_, IpcState>, stream_id: String, sequence: u64) {
    builtin_terminal_ack(state, stream_id, sequence);
}

#[tauri::command]
pub async fn builtin_agent_subscribe(
    app: AppHandle,
    state: State<'_, IpcState>,
    backend_url: String,
    stream_id: String,
    request: shellpilot_server::agent::chat::Request,
    execution_enabled: Option<bool>,
    on_event: Channel<Value>,
) -> Result<()> {
    let services = services_for_url(&app, &backend_url)?;
    if stream_id.is_empty() || stream_id.len() > 128 {
        return Err(Error::invalid("流 ID 无效"));
    }
    let stop = {
        let mut ops = state.operations.lock().unwrap();
        ops.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(300));
        if ops.len() >= 512 {
            return Err(Error::unavailable("本地请求过多"));
        }
        ops.entry(stream_id.clone())
            .or_insert_with(|| (CancellationToken::new(), Instant::now()))
            .0
            .clone()
    };
    let subscription = Arc::new(Subscription {
        stop,
        ack: tokio::sync::Notify::new(),
        sequence: std::sync::atomic::AtomicU64::new(0),
        acknowledged: std::sync::atomic::AtomicU64::new(0),
    });
    {
        let mut streams = state.streams.lock().unwrap();
        if streams.len() >= 256 || streams.contains_key(&stream_id) {
            return Err(Error::invalid("输出订阅重复或达到上限"));
        }
        streams.insert(stream_id.clone(), subscription.clone());
    }
    let _guard = AgentSubscriptionGuard {
        state: &state,
        id: stream_id,
        subscription: subscription.clone(),
    };
    agent_stream_mode(
        services,
        request,
        subscription,
        execution_enabled.unwrap_or(true),
        move |event| on_event.send(event).map_err(|_| ()),
    )
    .await
}

#[cfg(test)]
async fn agent_stream(
    services: Arc<Services>,
    request: shellpilot_server::agent::chat::Request,
    subscription: Arc<Subscription>,
    send: impl Fn(Value) -> std::result::Result<(), ()> + Send + Sync,
) -> Result<()> {
    agent_stream_mode(services, request, subscription, false, send).await
}
async fn agent_stream_mode(
    services: Arc<Services>, request: shellpilot_server::agent::chat::Request,
    subscription: Arc<Subscription>, execution_enabled: bool,
    send: impl Fn(Value) -> std::result::Result<(), ()> + Send + Sync,
) -> Result<()> {
    let trace=services.store.diagnostics.trace(&request.request_id,&request.session_id,&request.agent_id);
    let fields=json!({"entry":"desktop_ipc","messageBytes":request.message.len(),"attachmentCount":request.attachments.len(),"executionEnabled":execution_enabled});
    trace.request(fields,agent_stream_mode_inner(services,request,subscription,execution_enabled,send)).await
}
impl shellpilot_server::diagnostics::Failure for Error {
    fn diagnostic_code(&self)->&str {&self.code}
    fn cancelled(&self)->bool {matches!(self.code.as_str(),"AGENT_CANCELLED"|"AGENT_INTERRUPTED"|"BACKEND_UNAVAILABLE")}
}
async fn agent_stream_mode_inner(
    services: Arc<Services>,
    request: shellpilot_server::agent::chat::Request,
    subscription: Arc<Subscription>,
    execution_enabled: bool,
    send: impl Fn(Value) -> std::result::Result<(), ()> + Send + Sync,
) -> Result<()> {
    use shellpilot_server::agent::{chat, provider::ModelError};
    use std::sync::atomic::Ordering;
    if services.stop.is_cancelled() {
        return Err(Error::unavailable("工作区已停止"));
    }
    let receipt = services
        .agent
        .receipt(request.clone())
        .await
        .map_err(agent_error)?;
    let target = if let Some(turn) = receipt {
        turn.target
    } else {
        services
            .agent
            .text_target(request.clone())
            .await
            .map_err(agent_error)?
    };
    let request_id = request.request_id.clone();
    let result = services
        .agent
        .chat_desktop(request, target, execution_enabled, &subscription.stop, |event| {
            let send = &send;
            let subscription = subscription.clone();
            let services = services.clone();
            let request_id = request_id.clone();
            async move {
                let seq = subscription.sequence.fetch_add(1, Ordering::SeqCst) + 1;
                send(json!({"sequence":seq,"requestId":request_id,"payload":event}))
                    .map_err(|_| chat::Error::Model(ModelError::Cancelled))?;
                let acknowledged = async {
                    while subscription.acknowledged.load(Ordering::SeqCst) < seq {
                        subscription.ack.notified().await;
                    }
                };
                tokio::select! {biased;
                    _=subscription.stop.cancelled()=>Err(chat::Error::Model(ModelError::Cancelled)),
                    _=services.stop.cancelled()=>Err(chat::Error::Stopped),
                    result=tokio::time::timeout(Duration::from_secs(15),acknowledged)=>
                        result.map_err(|_|chat::Error::Model(ModelError::Timeout)),
                }
            }
        })
        .await;
    if let Err(error) = result {
        let failure = agent_error(error);
        // Final errors have no acknowledgement wait; a cancelled consumer must not stall cleanup.
        let _ = send(
            json!({"sequence":0,"requestId":request_id,"payload":{"event":"error","content":failure.message,"code":failure.code}}),
        );
        return Err(failure);
    }
    Ok(())
}
#[tauri::command]
pub fn builtin_terminal_unsubscribe(state: State<'_, IpcState>, stream_id: String) {
    if let Some(stream) = state.streams.lock().unwrap().get(&stream_id) {
        stream.stop.cancel();
    }
}
#[tauri::command]
pub async fn builtin_terminal_subscribe(
    app: AppHandle,
    state: State<'_, IpcState>,
    backend_url: String,
    session_id: String,
    stream_id: String,
    on_event: Channel<Value>,
) -> Result<()> {
    use std::sync::atomic::AtomicU64;
    let services = services_for_url(&app, &backend_url)?;
    let stop = {
        let mut ops = state.operations.lock().unwrap();
        ops.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(300));
        if ops.len() >= 512 {
            return Err(Error::unavailable("本地请求过多"));
        }
        ops.entry(stream_id.clone())
            .or_insert_with(|| (CancellationToken::new(), Instant::now()))
            .0
            .clone()
    };
    let subscription = Arc::new(Subscription {
        stop,
        ack: tokio::sync::Notify::new(),
        sequence: AtomicU64::new(0),
        acknowledged: AtomicU64::new(0),
    });
    {
        let mut streams = state.streams.lock().unwrap();
        if streams.len() >= 256 || streams.contains_key(&stream_id) {
            return Err(Error::invalid("输出订阅重复或达到上限"));
        }
        streams.insert(stream_id.clone(), subscription.clone());
    }
    let result = terminal_stream(services, session_id, subscription, move |event| {
        on_event.send(event).map_err(|_| ())
    })
    .await;
    state.streams.lock().unwrap().remove(&stream_id);
    state.operations.lock().unwrap().remove(&stream_id);
    result
}

async fn terminal_stream(
    services: Arc<Services>,
    session_id: String,
    subscription: Arc<Subscription>,
    send: impl Fn(Value) -> std::result::Result<(), ()>,
) -> Result<()> {
    use std::sync::atomic::Ordering;

    loop {
        let mut result = tokio::select! {biased; _=subscription.stop.cancelled()=>break, _=services.stop.cancelled()=>{
            send(json!({"sequence":0,"result":{"status":"DISCONNECTED","output":"","connected":false,"hasData":false,"bufferOverflow":false,"disconnectReason":"SESSION_NOT_FOUND","reconnectAllowed":false}})).map_err(|_| Error::unavailable("输出接收端已关闭"))?; break;
        }, result=services.terminals.read_chunk(&session_id)=>result};
        if result.status == "TIMEOUT" {
            continue;
        }
        if result.status == "REPLACED" {
            break;
        }
        let ended = matches!(result.status, "DISCONNECTED" | "READER_ERROR");
        let output = std::mem::take(&mut result.output);
        let payload =
            serde_json::to_value(&result).map_err(|_| Error::invalid("输出序列化失败"))?;
        let mut offset = 0;
        loop {
            let mut end = (offset + 65536).min(output.len());
            while !output.is_char_boundary(end) {
                end -= 1;
            }
            let mut payload = payload.clone();
            payload["output"] = json!(&output[offset..end]);
            let seq = subscription.sequence.fetch_add(1, Ordering::SeqCst) + 1;
            send(json!({"sequence":seq,"result":payload}))
                .map_err(|_| Error::unavailable("输出接收端已关闭"))?;
            let acknowledged = async {
                while subscription.acknowledged.load(Ordering::SeqCst) < seq {
                    subscription.ack.notified().await;
                }
            };
            tokio::select! {biased; _=subscription.stop.cancelled()=>return Ok(()), _=services.stop.cancelled()=>return Ok(()), result=tokio::time::timeout(Duration::from_secs(15),acknowledged)=>{result.map_err(|_| Error::unavailable("终端界面没有确认输出，订阅已暂停"))?;}}
            if end == output.len() {
                break;
            }
            offset = end;
        }
        if ended {
            break;
        }
        tokio::time::sleep(Duration::from_millis(8)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn builtin_pick_upload(
    app: AppHandle,
    backend_url: String,
    on_event: Channel<Value>,
    chat_only: Option<bool>,
    chat_limit: Option<usize>,
) -> Result<()> {
    let services = services_for_url(&app, &backend_url)?;
    let extensions: &[&str] = if chat_only.unwrap_or(false) {
        &[
            "png", "jpg", "jpeg", "webp", "pdf", "txt", "log", "csv", "json", "yaml", "yml", "md",
        ]
    } else {
        shellpilot_server::files::model::EXTENSIONS
    };
    let selected = rfd::AsyncFileDialog::new()
        .set_title("选择附件")
        .add_filter("附件", extensions)
        .pick_files()
        .await;
    let Some(selected) = selected else {
        return Ok(());
    };
    if chat_only.unwrap_or(false) {
        return attachment_input::upload_paths(
            &services,
            selected
                .iter()
                .map(|file| file.path().to_path_buf())
                .collect(),
            chat_limit.unwrap_or(4),
            20_000_000,
            |event| {
                on_event
                    .send(event)
                    .map_err(|_| Error::unavailable("附件接收端已关闭"))
            },
        )
        .await;
    }
    for selected in selected {
        if services.stop.is_cancelled() {
            return Err(Error::unavailable("服务已停止"));
        }
        let name = selected.file_name();
        let file = tokio::fs::File::open(selected.path())
            .await
            .map_err(|_| Error::invalid("无法打开所选附件"))?;
        let result = services
            .files
            .clone()
            .upload_reader(name.clone(), String::new(), file)
            .await;
        match result {
            Ok(file) => {
                let event = if chat_only.unwrap_or(false) {
                    attachment_input::uploaded_event(&services, file).await
                } else {
                    json!({"type":"uploaded","file":file})
                };
                on_event.send(event)
            }
            Err(error) => {
                on_event.send(json!({"type":"error","name":name,"message":error.message}))
            }
        }
        .map_err(|_| Error::unavailable("附件接收端已关闭"))?;
    }
    Ok(())
}
#[tauri::command]
pub async fn builtin_attachment_preview(
    app: AppHandle,
    backend_url: String,
    file_id: String,
) -> Result<String> {
    let services = services_for_url(&app, &backend_url)?;
    attachment_input::preview(&services, &file_id).await
}
#[tauri::command]
pub async fn builtin_clipboard_upload(
    app: AppHandle,
    backend_url: String,
    on_event: Channel<Value>,
    chat_limit: usize,
    chat_bytes: u64,
) -> Result<Option<String>> {
    let services = services_for_url(&app, &backend_url)?;
    let input = tokio::task::spawn_blocking(move || attachment_input::read(&app, chat_limit))
        .await
        .map_err(|_| Error::unavailable("剪贴板读取线程不可用"))??;
    let emit = |event| {
        on_event
            .send(event)
            .map_err(|_| Error::unavailable("附件接收端已关闭"))
    };
    match input {
        attachment_input::ClipboardInput::Files(paths) => {
            attachment_input::upload_paths(&services, paths, chat_limit, chat_bytes, emit).await?
        }
        attachment_input::ClipboardInput::Image(bytes) => {
            attachment_input::upload_image(&services, bytes, chat_limit, chat_bytes, emit).await?
        }
        attachment_input::ClipboardInput::Text(text) => return Ok(Some(text)),
        attachment_input::ClipboardInput::Empty => {
            return Err(Error::invalid("剪贴板中没有可粘贴的图片、文件或文字"))
        }
    }
    Ok(None)
}
#[tauri::command]
pub async fn builtin_save_attachment(
    app: AppHandle,
    backend_url: String,
    file_id: String,
) -> Result<bool> {
    let services = services_for_url(&app, &backend_url)?;
    let (asset, mut source) = match services.files.open_attachment(&file_id).await {
        Ok(value) => value,
        Err(error) => return Err(service_error(error).await),
    };
    let Some(destination) = rfd::AsyncFileDialog::new()
        .set_title("保存附件")
        .set_file_name(&asset.file_name)
        .save_file()
        .await
    else {
        return Ok(false);
    };
    // Refuse overwrite even if the dialog allowed it. Publish atomically from a sibling temp file.
    let target = destination.path();
    let parent = target
        .parent()
        .ok_or_else(|| Error::invalid("保存路径无效"))?;
    let temp = parent.join(format!(".shellpilot-{}.part", uuid::Uuid::new_v4()));
    let result=async {
        let mut output=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp).await.map_err(|_| Error::invalid("无法创建保存文件"))?;
        tokio::select! { _=services.stop.cancelled()=>return Err(Error::unavailable("保存已取消")), result=tokio::io::copy(&mut source,&mut output)=>{result.map_err(|_| Error::invalid("附件保存失败"))?;} }
        output.sync_all().await.map_err(|_| Error::invalid("附件保存失败"))?;
        drop(output);
        tokio::fs::hard_link(&temp,target).await.map_err(|_| Error::invalid("保存失败；请确认目标文件不存在，且目录支持硬链接"))?;
        Ok(true)
    }.await;
    let _ = tokio::fs::remove_file(temp).await;
    result
}
#[cfg(all(test, windows))]
#[path = "backend_ipc_tests.rs"]
mod tests;
