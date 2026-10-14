use super::*;
#[path = "../../../ai-ssh-terminal-server-rust/tests/support/mod.rs"]
#[allow(dead_code)]
mod protocol;
use std::sync::atomic::{AtomicU64, Ordering};

fn subscription() -> Arc<Subscription> {
    Arc::new(Subscription {
        stop: CancellationToken::new(),
        ack: tokio::sync::Notify::new(),
        sequence: AtomicU64::new(0),
        acknowledged: AtomicU64::new(0),
    })
}
fn acknowledge(subscription: &Subscription, sequence: u64) {
    subscription.acknowledged.store(sequence, Ordering::SeqCst);
    subscription.ack.notify_one();
}
async fn services() -> (tempfile::TempDir, Arc<Services>) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        Arc::new(shellpilot_server::store::Store::open(&dir.path().join("db.sqlite3")).unwrap());
    let services = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    (dir, services)
}

#[tokio::test]
async fn model_configuration_ipc_scopes_revisions_and_validation() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let list = dispatch(
        services.clone(),
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    assert_eq!(list[0]["id"], "model");
    assert_eq!(list[0]["ready"], true);
    let mut request = json!({"id":"model","userId":"default","revision":1,"update":{"config":list[0]["config"],"apiKey":{"action":"keep"}}});
    request["update"]["config"]["model"] = json!("edited");
    let edited = dispatch(
        services.clone(),
        "agent/models",
        "POST",
        request.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(edited["revision"], 2);
    let stale = dispatch(
        services.clone(),
        "agent/models",
        "POST",
        request.clone(),
        Value::Null,
    )
    .await
    .unwrap_err();
    assert_eq!(
        (stale.status, stale.code.as_str()),
        (409, "MODEL_CONFIG_CHANGED")
    );
    request["revision"] = json!(2);
    request["update"]["config"]["outputReserve"] = json!(9999999);
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/models",
            "POST",
            request,
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/models",
            "GET",
            Value::Null,
            json!({"userId":"other"})
        )
        .await
        .unwrap(),
        json!([])
    );
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/models",
            "DELETE",
            json!({"id":"model","userId":"other","revision":2}),
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        404
    );
    dispatch(
        services.clone(),
        "agent/models",
        "DELETE",
        json!({"id":"model","userId":"default","revision":2}),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(
        dispatch(
            services,
            "agent/models",
            "GET",
            Value::Null,
            json!({"userId":"default"})
        )
        .await
        .unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn model_name_edit_uses_stable_id_and_keeps_session_binding() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    let profile = shellpilot_server::agent::provider::ModelRepository::new(services.store.clone())
        .get("model", "default")
        .unwrap();
    let saved = dispatch(services.clone(), "agent/models", "POST", json!({"id":"model","displayName":"重命名后的配置","userId":"default","revision":1,"update":{"config":profile.config,"apiKey":{"action":"keep"}}}), Value::Null).await.unwrap();
    assert_eq!(saved["id"], "model");
    assert_eq!(saved["displayName"], "重命名后的配置");
    let agents = services.agent.list("default".into()).await.unwrap();
    assert_eq!(agents[0].agent_id, "model");
    assert_eq!(agents[0].agent_name, "重命名后的配置");
    assert_eq!(agents[0].model_name, "mock-model");
    let history = services
        .agent
        .history("model".into(), "default".into(), session, 0, 20)
        .await
        .unwrap();
    assert_eq!(history.session.agent_id, "model");
}

#[cfg(windows)]
#[tokio::test]
async fn model_configuration_ipc_never_returns_saved_key() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let list = dispatch(
        services.clone(),
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    let mut request = json!({"id":"model","userId":"default","revision":1,"update":{"config":list[0]["config"],"apiKey":{"action":"set","value":"fake-test-key"}}});
    request["update"]["config"]["requireApiKey"] = json!(true);
    let saved = dispatch(
        services.clone(),
        "agent/models",
        "POST",
        request.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(saved["apiKeyConfigured"], true);
    assert!(!saved.to_string().contains("fake-test-key"));
    request["revision"] = json!(2);
    request["update"]["apiKey"] = json!({"action":"keep"});
    request["update"]["config"]["baseUrl"] = json!("http://127.0.0.1:2/v1/");
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/models",
            "POST",
            request.clone(),
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    request["update"]["apiKey"] = json!({"action":"clear"});
    let cleared = dispatch(services, "agent/models", "POST", request, Value::Null)
        .await
        .unwrap();
    assert_eq!(cleared["ready"], false);
    assert_eq!(cleared["apiKeyConfigured"], false);
}

fn save_test_model(services: &Services, base_url: String) {
    use shellpilot_server::agent::provider::*;
    let config = ModelConfig {
        provider: ProviderKind::OpenAiCompatible,
        remote_compaction: false,
        base_url,
        completions_path: "chat/completions".into(),
        model: "mock-model".into(),
        context_window: 8192,
        output_reserve: 512,
        safety_reserve: 256,
        compact_percent: 75,
        output_token_parameter: OutputTokenParameter::MaxCompletionTokens,
        capabilities: ModelCapabilities::default(),
        temperature: None,
        reasoning_effort: None,
        timeout_seconds: 3,
        max_response_bytes: 65536,
        require_api_key: false,
    };
    ModelRepository::new(services.store.clone())
        .save(
            "model",
            "default",
            0,
            ModelConfigUpdate {
                config,
                api_key: KeyChange::Keep,
            },
        )
        .unwrap();
}
async fn model_server(stall: bool) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1/", listener.local_addr().unwrap());
    let router = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |axum::Json(request): axum::Json<Value>| async move {
            assert_eq!(request["stream"], true);
            let text = format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"content":"汉🙂"},"finish_reason":null}]})
            );
            let finish = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
            );
            let body = axum::body::Body::from_stream(async_stream_for_ipc(text, finish, stall));
            axum::response::Response::builder()
                .header("content-type", "text/event-stream")
                .body(body)
                .unwrap()
        }),
    );
    (
        base,
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }),
    )
}
fn async_stream_for_ipc(
    text: String,
    finish: String,
    stall: bool,
) -> impl futures_util::Stream<Item = std::io::Result<axum::body::Bytes>> {
    futures_util::stream::unfold((0, text, finish), move |(step, text, finish)| async move {
        match step {
            0 => Some((Ok(axum::body::Bytes::from(text.clone())), (1, text, finish))),
            1 => {
                if stall {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                Some((
                    Ok(axum::body::Bytes::from(finish)),
                    (2, String::new(), String::new()),
                ))
            }
            _ => None,
        }
    })
}
#[tokio::test]
async fn agent_control_dispatch_lists_owner_scoped_models_and_creates_native_session() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let configs = dispatch(
        services.clone(),
        "agent/query_ai_agent_config_list",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    assert_eq!(configs[0]["agentId"], "model");
    assert!(configs[0].get("apiKey").is_none());
    let other = dispatch(
        services.clone(),
        "agent/query_ai_agent_config_list",
        "GET",
        Value::Null,
        json!({"userId":"other"}),
    )
    .await
    .unwrap();
    assert!(other.as_array().unwrap().is_empty());
    let created = dispatch(
        services.clone(),
        "agent/create_session",
        "POST",
        json!({"agentId":"model","userId":"default"}),
        Value::Null,
    )
    .await
    .unwrap();
    let stopped = dispatch(
        services.clone(),
        "agent/stop_chat",
        "POST",
        json!({"agentId":"model","userId":"default","sessionId":created["sessionId"]}),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(stopped, false);
    let error = dispatch(
        services.clone(),
        "agent/create_session",
        "POST",
        json!({"agentId":"model","userId":"other"}),
        Value::Null,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "AGENT_NOT_FOUND");
    assert_eq!(error.status, 404);
}
#[tokio::test]
async fn agent_channel_waits_for_each_frame_ack_and_finishes_without_backend_http_listener() {
    let (_dir, services) = services().await;
    let (base, server) = model_server(false).await;
    save_test_model(&services, base);
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    let request=serde_json::from_value(json!({"agentId":"model","userId":"default","sessionId":session,"terminalSessionId":"","message":"hello"})).unwrap();
    let sub = subscription();
    let (token, mut frames) = tokio::sync::mpsc::channel(1);
    let stream = sub.clone();
    let operation = tokio::spawn(agent_stream(services, request, stream, move |e| {
        token.try_send(e).map_err(|_| ())
    }));
    let first = tokio::time::timeout(Duration::from_secs(2), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["payload"], json!({"event":"text","content":"汉🙂"}));
    assert!(
        tokio::time::timeout(Duration::from_millis(25), frames.recv())
            .await
            .is_err()
    );
    acknowledge(&sub, first["sequence"].as_u64().unwrap());
    let done = frames.recv().await.unwrap();
    assert_eq!(done["payload"]["event"], "done");
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    operation.await.unwrap().unwrap();
    server.abort();
}
#[tokio::test]
async fn agent_stop_control_cancels_model_stream_and_emits_compatible_error() {
    let (_dir, services) = services().await;
    let (base, server) = model_server(true).await;
    save_test_model(&services, base);
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    let request=serde_json::from_value(json!({"agentId":"model","userId":"default","sessionId":session,"terminalSessionId":"","message":"hello"})).unwrap();
    let sub = subscription();
    let (token, mut frames) = tokio::sync::mpsc::channel(1);
    let stream = sub.clone();
    let operation = tokio::spawn(agent_stream(services.clone(), request, stream, move |e| {
        token.try_send(e).map_err(|_| ())
    }));
    let first = tokio::time::timeout(Duration::from_secs(2), frames.recv())
        .await
        .unwrap()
        .unwrap();
    acknowledge(&sub, first["sequence"].as_u64().unwrap());
    assert_eq!(
        dispatch(
            services,
            "agent/stop_chat",
            "POST",
            json!({"agentId":"model","userId":"default","sessionId":session}),
            Value::Null
        )
        .await
        .unwrap(),
        true
    );
    let error = tokio::time::timeout(Duration::from_secs(2), frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(error["payload"]["event"], "error");
    assert_eq!(error["payload"]["code"], "AGENT_CANCELLED");
    assert_eq!(
        operation.await.unwrap().unwrap_err().code,
        "AGENT_CANCELLED"
    );
    server.abort();
}

#[test]
fn dropped_agent_subscription_cleans_only_its_own_registration_and_cancellation_receipt() {
    let state = IpcState::default();
    let sub = subscription();
    let other = subscription();
    state
        .streams
        .lock()
        .unwrap()
        .insert("agent-stream".into(), sub.clone());
    state
        .streams
        .lock()
        .unwrap()
        .insert("other".into(), other.clone());
    state
        .operations
        .lock()
        .unwrap()
        .insert("agent-stream".into(), (sub.stop.clone(), Instant::now()));
    {
        let _guard = AgentSubscriptionGuard {
            state: &state,
            id: "agent-stream".into(),
            subscription: sub.clone(),
        };
    }
    assert!(sub.stop.is_cancelled());
    assert!(!other.stop.is_cancelled());
    assert_eq!(state.streams.lock().unwrap().len(), 1);
    assert!(state.operations.lock().unwrap().is_empty());
}
#[tokio::test]
async fn agent_history_scope_and_replay_work_through_native_dispatch_without_a_second_model_request(
) {
    let (_dir, services) = services().await;
    let (base, server) = model_server(false).await;
    save_test_model(&services, base);
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    let request:shellpilot_server::agent::chat::Request=serde_json::from_value(json!({"requestId":"stable-native-turn","agentId":"model","userId":"default","sessionId":session,"terminalSessionId":"","message":"hello"})).unwrap();
    services
        .agent
        .chat(
            request.clone(),
            None,
            &CancellationToken::new(),
            |_| async { Ok(()) },
        )
        .await
        .unwrap();
    server.abort(); // Cached replay must work without the original model server.
    let sub = subscription();
    let stream = sub.clone();
    let (token, mut events) = tokio::sync::mpsc::channel(1);
    let copy = services.clone();
    let run = tokio::spawn(agent_stream(copy, request, stream, move |e| {
        token.try_send(e).map_err(|_| ())
    }));
    let done = events.recv().await.unwrap();
    assert_eq!(done["payload"]["event"], "done");
    assert_eq!(done["requestId"], "stable-native-turn");
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    let params =
        json!({"agentId":"model","userId":"default","sessionId":session,"after":"0","limit":"1"});
    let history = dispatch(
        services.clone(),
        "agent/chat_history",
        "GET",
        Value::Null,
        params.clone(),
    )
    .await
    .unwrap();
    assert_eq!(history["turns"][0]["state"], "completed");
    assert_eq!(history["turns"][0]["requestId"], "stable-native-turn");
    let mut other = params.clone();
    other["userId"] = "other".into();
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/chat_history",
            "GET",
            Value::Null,
            other
        )
        .await
        .unwrap_err()
        .status,
        404
    );
    let events = dispatch(
        services.clone(),
        "agent/events",
        "GET",
        Value::Null,
        params.clone(),
    )
    .await
    .unwrap();
    assert_eq!(events.as_array().unwrap().len(), 1);
    let mut bad = params;
    bad["limit"] = "500".into();
    assert_eq!(
        dispatch(services, "agent/chat_history", "GET", Value::Null, bad)
            .await
            .unwrap_err()
            .status,
        400
    );
}
#[tokio::test]
async fn direct_dispatch_crud_errors_and_stop_do_not_need_an_http_listener() {
    let (_dir, services) = services().await;
    let created=dispatch(services.clone(),"ssh/create_connection","POST",json!({"connectionName":"IPC","host":"localhost","port":22,"username":"tester","password":"private-test-value","strictHostKeyCheck":false}),json!({})).await.unwrap();
    assert!(created.get("password").is_none());
    let id = created["connectionId"].as_str().unwrap();
    let listed = dispatch(
        services.clone(),
        "ssh/connection_list",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(
        dispatch(
            services.clone(),
            "ssh/get_connection",
            "GET",
            Value::Null,
            json!({"connectionId":id})
        )
        .await
        .unwrap()["connectionName"],
        "IPC"
    );
    assert_eq!(
        dispatch(
            services.clone(),
            "ssh/get_connection",
            "GET",
            Value::Null,
            json!({"connectionId":"missing"})
        )
        .await
        .unwrap_err()
        .code,
        "S0001"
    );
    assert_eq!(
        dispatch(
            services.clone(),
            "ssh/terminal/resize",
            "POST",
            json!({"sessionId":"missing","cols":5000000000u64,"rows":24}),
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/chat_stream",
            "POST",
            json!({}),
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    dispatch(
        services.clone(),
        "ssh/delete_connection",
        "POST",
        Value::Null,
        json!({"connectionId":id}),
    )
    .await
    .unwrap();
    services.shutdown().await;
    assert_eq!(
        dispatch(services, "health", "GET", Value::Null, Value::Null)
            .await
            .unwrap_err()
            .status,
        503
    );
}

#[tokio::test]
async fn eight_quiet_channel_subscriptions_do_not_block_input_or_close_sibling_shells() {
    let fixture = protocol::Fixture::new(Default::default()).await;
    let (store, connection) = fixture.saved(false);
    let services = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    let mut sessions = vec![];
    let mut subscribers = vec![];
    for _ in 0..8 {
        let opened = services
            .terminals
            .connect(protocol::open(&connection.connection_id))
            .await
            .unwrap();
        let id = opened.session_id;
        let subscription = subscription();
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(terminal_stream(
            services.clone(),
            id.clone(),
            subscription.clone(),
            move |event| sender.try_send(event).map_err(|_| ()),
        ));
        sessions.push(id);
        subscribers.push((subscription, receiver, task));
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        for (index, id) in sessions.iter().enumerate() {
            dispatch(
                services.clone(),
                "ssh/terminal/write",
                "POST",
                json!({"sessionId":id,"input":format!("window-{index}\n")}),
                Value::Null,
            )
            .await
            .unwrap();
        }
    })
    .await
    .unwrap();
    for (index, (subscription, receiver, _)) in subscribers.iter_mut().enumerate() {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = receiver.recv().await.unwrap();
                acknowledge(subscription, event["sequence"].as_u64().unwrap());
                if event["result"]["output"]
                    .as_str()
                    .unwrap()
                    .contains(&format!("window-{index}"))
                {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }
    subscribers[0].0.stop.cancel();
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(services.terminals.connected(&sessions[0]).connected);
    services.terminals.close(&sessions[1]);
    for id in sessions.iter().skip(2) {
        assert!(services.terminals.connected(id).connected);
    }
    services.shutdown().await;
    for (_, _, task) in subscribers {
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn unicode_channel_frames_are_bounded_and_wait_for_their_acknowledgement() {
    let fixture = protocol::Fixture::new(Default::default()).await;
    let (store, connection) = fixture.saved(false);
    let services = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    let opened = services
        .terminals
        .connect(protocol::open(&connection.connection_id))
        .await
        .unwrap();
    let input = "汉🙂".repeat(16000);
    services
        .terminals
        .write(&opened.session_id, input.clone())
        .await
        .unwrap();
    let subscription = subscription();
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    let task = tokio::spawn(terminal_stream(
        services.clone(),
        opened.session_id,
        subscription.clone(),
        move |event| sender.try_send(event).map_err(|_| ()),
    ));
    let first = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(40), receiver.recv())
            .await
            .is_err()
    );
    let mut output = String::new();
    let mut event = first;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let text = event["result"]["output"].as_str().unwrap();
            assert!(text.len() <= 65536);
            output.push_str(text);
            acknowledge(&subscription, event["sequence"].as_u64().unwrap());
            if output.contains(&input) {
                break;
            }
            event = receiver.recv().await.unwrap();
        }
    })
    .await
    .unwrap();
    subscription.stop.cancel();
    task.await.unwrap().unwrap();
    services.shutdown().await;
}

#[tokio::test]
async fn cancelling_before_a_subscription_starts_never_opens_or_retries_an_ssh_shell() {
    let (_dir, services) = services().await;
    let subscription = subscription();
    subscription.stop.cancel();
    terminal_stream(services.clone(), "missing".into(), subscription, |_| {
        panic!("cancelled stream must not emit")
    })
    .await
    .unwrap();
    services.shutdown().await;
}

// B5: real loopback model HTTP feeds the same native dispatch/Channel functions used by Tauri.
// No ShellPilot HTTP service, user credentials, SSH connection or production database is used.
async fn b5_model_server() -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1/", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let router = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |axum::Json(request): axum::Json<Value>| {
            let captured = captured.clone();
            async move {
                let mode = request["messages"].as_array().unwrap().last().unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                captured.lock().unwrap().push(request);
                let first = format!(
                    "data: {}\r\n\r\n",
                    json!({"choices":[{"index":0,"delta":{"content":"汉🙂"},"finish_reason":null}]})
                );
                let finish = if mode == "broken" {
                    "data: {provider-private-error\r\n\r\n".into()
                } else {
                    format!(
                        "data: {}\r\n\r\ndata: [DONE]\r\n\r\n",
                        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]})
                    )
                };
                axum::response::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from_stream(async_stream_for_ipc(
                        first,
                        finish,
                        mode == "stall",
                    )))
                    .unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, requests, server)
}
fn b5_request(session: &str, id: &str, message: &str) -> shellpilot_server::agent::chat::Request {
    serde_json::from_value(json!({"requestId":id,"agentId":"model","userId":"default",
        "sessionId":session,"terminalSessionId":"","message":message}))
    .unwrap()
}
fn b5_start(
    services: Arc<Services>,
    request: shellpilot_server::agent::chat::Request,
) -> (
    Arc<Subscription>,
    tokio::sync::mpsc::Receiver<Value>,
    tokio::task::JoinHandle<Result<()>>,
) {
    let sub = subscription();
    let stream = sub.clone();
    let (send, receive) = tokio::sync::mpsc::channel(4);
    let run = tokio::spawn(agent_stream(services, request, stream, move |event| {
        send.try_send(event).map_err(|_| ())
    }));
    (sub, receive, run)
}
async fn b5_frame(frames: &mut tokio::sync::mpsc::Receiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(3), frames.recv())
        .await
        .unwrap()
        .unwrap()
}
async fn b5_history(services: Arc<Services>, session: &str) -> Value {
    dispatch(
        services,
        "agent/chat_history",
        "GET",
        Value::Null,
        json!({"agentId":"model","userId":"default","sessionId":session,"after":"0"}),
    )
    .await
    .unwrap()
}
async fn b5_stop(services: Arc<Services>, session: &str, request: &str) -> Value {
    dispatch(
        services,
        "agent/stop_chat",
        "POST",
        json!({"agentId":"model","userId":"default","sessionId":session,"requestId":request}),
        Value::Null,
    )
    .await
    .unwrap()
}
async fn b5_cached(services: Arc<Services>, request: shellpilot_server::agent::chat::Request) {
    let (sub, mut frames, run) = b5_start(services, request);
    let done = b5_frame(&mut frames).await;
    assert_eq!(done["payload"], json!({"event":"done","content":"汉🙂"}));
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    tokio::time::timeout(Duration::from_secs(3), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(frames.recv().await.is_none());
}
#[tokio::test]
async fn b5_native_stop_without_ack_continue_and_reopen_do_not_reexecute_old_turns() {
    let (dir, services) = services().await;
    let (base, requests, server) = b5_model_server().await;
    save_test_model(&services, base);
    let created = dispatch(
        services.clone(),
        "agent/create_session",
        "POST",
        json!({"agentId":"model","userId":"default"}),
        Value::Null,
    )
    .await
    .unwrap();
    let session = created["sessionId"].as_str().unwrap().to_owned();
    let cancelled = b5_request(&session, "b5-stopped", "stall");
    let (old_sub, mut frames, run) = b5_start(services.clone(), cancelled.clone());
    let first = b5_frame(&mut frames).await;
    assert_eq!(first["requestId"], "b5-stopped");
    assert_eq!(first["payload"]["content"], "汉🙂");
    assert_eq!(
        b5_stop(services.clone(), &session, "unrelated-turn").await,
        false
    );
    assert_eq!(
        b5_history(services.clone(), &session).await["turns"][0]["state"],
        "running"
    );
    // Stop must work while the renderer has not acknowledged the first frame.
    assert_eq!(
        b5_stop(services.clone(), &session, "b5-stopped").await,
        true
    );
    let error = b5_frame(&mut frames).await;
    assert_eq!(error["sequence"], 0);
    assert_eq!(error["payload"]["code"], "AGENT_CANCELLED");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), run)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "AGENT_CANCELLED"
    );

    let completed = b5_request(&session, "b5-continued", "continue");
    let (sub, mut frames, run) = b5_start(services.clone(), completed.clone());
    let first = b5_frame(&mut frames).await;
    assert_eq!(
        b5_stop(services.clone(), &session, "b5-stopped").await,
        false
    );
    acknowledge(&old_sub, first["sequence"].as_u64().unwrap()); // A late ACK belongs to the old subscription.
    assert!(
        tokio::time::timeout(Duration::from_millis(30), frames.recv())
            .await
            .is_err()
    );
    acknowledge(&sub, first["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    assert_eq!(done["requestId"], "b5-continued");
    assert_eq!(done["payload"]["event"], "done");
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    let history = b5_history(services.clone(), &session).await;
    assert_eq!(history["turns"][0]["state"], "cancelled");
    assert_eq!(history["turns"][0]["partialText"], "汉🙂");
    assert!(history["turns"][0]["resultText"].is_null());
    assert_eq!(history["turns"][1]["state"], "completed");
    assert_eq!(history["turns"][1]["resultText"], "汉🙂");
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["messages"].as_array().unwrap().len(), 2);
        assert_eq!(requests[1]["messages"][1]["content"], "continue");
    }
    let (_, mut errors, replay) = b5_start(services.clone(), cancelled);
    assert_eq!(
        b5_frame(&mut errors).await["payload"]["code"],
        "AGENT_CANCELLED"
    );
    assert_eq!(replay.await.unwrap().unwrap_err().code, "AGENT_CANCELLED");
    services.shutdown().await;
    drop(services);
    server.abort();
    let store =
        Arc::new(shellpilot_server::store::Store::open(&dir.path().join("db.sqlite3")).unwrap());
    let restored = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    assert_eq!(
        b5_history(restored.clone(), &session).await["turns"],
        history["turns"]
    );
    b5_cached(restored.clone(), completed).await; // Model server is gone; completion must come from SQLite.
    assert_eq!(requests.lock().unwrap().len(), 2);
    restored.shutdown().await;
}
#[tokio::test]
async fn b5_dropped_native_subscription_recovers_partial_and_requires_an_explicit_new_request() {
    let (_dir, services) = services().await;
    let (base, requests, server) = b5_model_server().await;
    save_test_model(&services, base);
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    let request = b5_request(&session, "b5-interrupted", "stall");
    let (_, mut frames, run) = b5_start(services.clone(), request.clone());
    assert_eq!(b5_frame(&mut frames).await["payload"]["content"], "汉🙂");
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let history = b5_history(services.clone(), &session).await;
            if history["turns"][0]["state"] == "interrupted" {
                assert_eq!(history["turns"][0]["partialText"], "汉🙂");
                assert_eq!(history["turns"][0]["errorCode"], "AGENT_INTERRUPTED");
                assert!(history["turns"][0]["resultText"].is_null());
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (_, mut errors, replay) = b5_start(services.clone(), request);
    assert_eq!(
        b5_frame(&mut errors).await["payload"]["code"],
        "AGENT_INTERRUPTED"
    );
    assert_eq!(replay.await.unwrap().unwrap_err().code, "AGENT_INTERRUPTED");
    assert_eq!(requests.lock().unwrap().len(), 1);
    let (sub, mut frames, run) = b5_start(
        services.clone(),
        b5_request(&session, "b5-explicit-retry", "continue"),
    );
    let text = b5_frame(&mut frames).await;
    acknowledge(&sub, text["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(
        b5_history(services.clone(), &session).await["turns"][1]["state"],
        "completed"
    );
    services.shutdown().await;
    server.abort();
}
#[tokio::test]
async fn b5_provider_protocol_failure_keeps_native_history_and_redacts_error_frames() {
    let (_dir, services) = services().await;
    let (base, requests, server) = b5_model_server().await;
    save_test_model(&services, base);
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    let request = b5_request(&session, "b5-protocol-failure", "broken");
    let (sub, mut frames, run) = b5_start(services.clone(), request.clone());
    let text = b5_frame(&mut frames).await;
    acknowledge(&sub, text["sequence"].as_u64().unwrap());
    let error = b5_frame(&mut frames).await;
    assert_eq!(error["payload"]["code"], "MODEL_PROTOCOL_FAILED");
    assert_eq!(error["sequence"], 0);
    assert!(!error.to_string().contains("provider-private-error"));
    assert_eq!(
        run.await.unwrap().unwrap_err().code,
        "MODEL_PROTOCOL_FAILED"
    );
    let history = b5_history(services.clone(), &session).await;
    assert_eq!(history["turns"][0]["state"], "failed");
    assert_eq!(history["turns"][0]["partialText"], "汉🙂");
    assert!(history["turns"][0]["resultText"].is_null());
    let (_, mut frames, replay) = b5_start(services.clone(), request);
    assert_eq!(
        b5_frame(&mut frames).await["payload"]["code"],
        "MODEL_PROTOCOL_FAILED"
    );
    replay.await.unwrap().unwrap_err();
    assert_eq!(requests.lock().unwrap().len(), 1);
    services.shutdown().await;
    server.abort();
}

// C2 exercises real model HTTP -> native IPC -> SQLite with no ShellPilot HTTP listener.
struct C2Model {
    summaries: AtomicU64,
    streams: AtomicU64,
    hold: std::sync::atomic::AtomicBool,
    arrived: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
async fn c2_model_server() -> (String, Arc<C2Model>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1/", listener.local_addr().unwrap());
    let state = Arc::new(C2Model {
        summaries: AtomicU64::new(0),
        streams: AtomicU64::new(0),
        hold: std::sync::atomic::AtomicBool::new(false),
        arrived: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let router=axum::Router::new().route("/v1/chat/completions",axum::routing::post(
        |axum::extract::State(state):axum::extract::State<Arc<C2Model>>,axum::Json(body):axum::Json<Value>|async move {
            assert!(body.get("tools").is_none());
            if body["stream"]==true {
                state.streams.fetch_add(1,Ordering::SeqCst);
                let data=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                    json!({"choices":[{"index":0,"delta":{"content":"a".repeat(1000)},"finish_reason":null}]}),
                    json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}));
                return axum::response::Response::builder().header("content-type","text/event-stream")
                    .body(axum::body::Body::from(data)).unwrap();
            }
            state.summaries.fetch_add(1,Ordering::SeqCst);state.arrived.notify_one();
            if state.hold.load(Ordering::SeqCst) {state.release.notified().await;}
            let source:Value=serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let content=json!({"summary":"先前讨论日志，尚未执行命令；原历史仍然保留。","nextSteps":["继续只读分析"],
                "evidenceEventIds":[source["availableEvidenceEventIds"].as_array().unwrap().last().unwrap()]}).to_string();
            axum::response::Response::builder().header("content-type","application/json").body(axum::body::Body::from(
                json!({"choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}]}).to_string())).unwrap()
        })).with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, state, server)
}
async fn c2_seed(services: Arc<Services>, base: String) -> String {
    c2_seed_target(services, base, None).await
}
async fn c2_seed_target(
    services: Arc<Services>,
    base: String,
    target: Option<shellpilot_server::agent::Target>,
) -> String {
    save_test_model(&services, base);
    let profile = dispatch(
        services.clone(),
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    let mut config = profile[0]["config"].clone();
    config["contextWindow"] = json!(32768);
    dispatch(
        services.clone(),
        "agent/models",
        "POST",
        json!({"id":"model","userId":"default","revision":profile[0]["revision"],
        "update":{"config":config,"apiKey":{"action":"keep"}}}),
        Value::Null,
    )
    .await
    .unwrap();
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    for i in 0..8 {
        let message = if i == 0 {
            "只读解释日志".into()
        } else {
            "u".repeat(1000)
        };
        let mut request = b5_request(&session, &format!("seed-{}", i), &message);
        request.terminal_session_id = target
            .as_ref()
            .map(|t| t.terminal_session_id.clone())
            .unwrap_or_default();
        services
            .agent
            .chat(
                request,
                target.clone(),
                &CancellationToken::new(),
                |_| async { Ok(()) },
            )
            .await
            .unwrap();
    }
    let profile = dispatch(
        services.clone(),
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    let mut config = profile[0]["config"].clone();
    config["contextWindow"] = json!(8192);
    config["compactPercent"] = json!(60);
    dispatch(
        services.clone(),
        "agent/models",
        "POST",
        json!({"id":"model","userId":"default","revision":profile[0]["revision"],
        "update":{"config":config,"apiKey":{"action":"keep"}}}),
        Value::Null,
    )
    .await
    .unwrap();
    session
}
#[tokio::test]
async fn c2_compaction_flows_through_native_channel_and_preserves_visible_history() {
    let (_dir, services) = services().await;
    let (base, model, server) = c2_model_server().await;
    let session = c2_seed(services.clone(), base).await;
    let request = b5_request(&session, "c2-native", "最新问题");
    let (sub, mut frames, run) = b5_start(services.clone(), request);
    let text = b5_frame(&mut frames).await;
    assert_eq!(text["requestId"], "c2-native");
    assert_eq!(text["payload"]["event"], "text");
    assert_eq!(text["payload"]["content"], "a".repeat(1000));
    acknowledge(&sub, text["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    assert_eq!(done["payload"]["event"], "done");
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    assert_eq!(model.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(model.streams.load(Ordering::SeqCst), 9);
    let history = b5_history(services.clone(), &session).await;
    assert!(history["session"]["checkpointId"].is_string());
    assert_eq!(history["turns"].as_array().unwrap().len(), 9);
    assert!(history["turns"]
        .as_array()
        .unwrap()
        .iter()
        .all(|turn| turn["state"] == "completed"));
    assert_eq!(history["turns"][8]["requestId"], "c2-native");
    services.shutdown().await;
    server.abort();
}
#[tokio::test]
async fn c2_native_stop_during_summary_works_before_any_text_frame_or_turn_admission() {
    let (_dir, services) = services().await;
    let (base, model, server) = c2_model_server().await;
    let session = c2_seed(services.clone(), base).await;
    model.hold.store(true, Ordering::SeqCst);
    let (_, mut frames, run) = b5_start(
        services.clone(),
        b5_request(&session, "c2-stop", "最新问题"),
    );
    tokio::time::timeout(Duration::from_secs(3), model.arrived.notified())
        .await
        .unwrap();
    assert_eq!(b5_stop(services.clone(), &session, "c2-stop").await, true);
    let error = b5_frame(&mut frames).await;
    assert_eq!(error["sequence"], 0);
    assert_eq!(error["payload"]["code"], "AGENT_CANCELLED");
    assert_eq!(run.await.unwrap().unwrap_err().code, "AGENT_CANCELLED");
    let history = b5_history(services.clone(), &session).await;
    assert!(history["session"]["checkpointId"].is_null());
    assert_eq!(history["turns"].as_array().unwrap().len(), 8);
    assert_eq!(model.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(model.streams.load(Ordering::SeqCst), 8);
    model.release.notify_one();
    services.shutdown().await;
    server.abort();
}

// C3 keeps provider windows inside Rust; Channel only carries visible text and final state.
async fn c3_model_server() -> (String, Arc<C2Model>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1/", listener.local_addr().unwrap());
    let state = Arc::new(C2Model {
        summaries: AtomicU64::new(0),
        streams: AtomicU64::new(0),
        hold: std::sync::atomic::AtomicBool::new(false),
        arrived: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let handle = |axum::extract::State(state): axum::extract::State<Arc<C2Model>>,
                  uri: axum::http::Uri,
                  axum::Json(body): axum::Json<Value>| async move {
        assert!(body.get("tools").is_none());
        let value = if uri.path().ends_with("input_tokens") {
            let cost = body["input"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    if item["type"] == "compaction" {
                        return 100;
                    }
                    let n = if let Some(s) = item["content"].as_str() {
                        s.len()
                    } else {
                        item["content"].as_array().map_or(0, |parts| {
                            parts
                                .iter()
                                .map(|p| p["text"].as_str().map_or(0, str::len))
                                .sum()
                        })
                    };
                    n.div_ceil(3) as u64 + 12
                })
                .sum::<u64>()
                + body["instructions"]
                    .as_str()
                    .map_or(0, |s| s.len().div_ceil(3)) as u64;
            json!({"object":"response.input_tokens","input_tokens":cost})
        } else if uri.path().ends_with("compact") {
            state.summaries.fetch_add(1, Ordering::SeqCst);
            state.arrived.notify_one();
            if state.hold.load(Ordering::SeqCst) {
                state.release.notified().await;
            }
            json!({"object":"response.compaction","output":[
                {"id":"retained-user","type":"message","role":"user","content":[{"type":"input_text","text":"保留的原问题"}]},
                {"id":"native-compact","type":"compaction","encrypted_content":"native-opaque-do-not-display"}]})
        } else {
            assert_eq!(body["store"], false);
            assert_eq!(body["truncation"], "disabled");
            state.streams.fetch_add(1, Ordering::SeqCst);
            let item = json!({"id":"native-message","type":"message","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":"a".repeat(1000),"annotations":[]}]});
            let events = vec![
                json!({"type":"response.created","response":{"id":"native-response","status":"in_progress"}}),
                json!({"type":"response.output_item.added","output_index":0,
                    "item":{"id":"native-message","type":"message","role":"assistant","status":"in_progress","content":[]}}),
                json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"native-message","delta":"a".repeat(1000)}),
                json!({"type":"response.output_item.done","output_index":0,"item":item}),
                json!({"type":"response.completed","response":{"id":"native-response","object":"response","status":"completed","output":[item],
                    "usage":{"input_tokens":100,"output_tokens":25,"total_tokens":125}}}),
            ];
            let data: String = events
                .into_iter()
                .enumerate()
                .map(|(i, mut event)| {
                    event["sequence_number"] = json!(i);
                    format!("data: {event}\n\n")
                })
                .collect();
            return axum::response::Response::builder()
                .header("content-type", "text/event-stream")
                .body(axum::body::Body::from(data))
                .unwrap();
        };
        axum::response::Response::builder()
            .header("content-type", "application/json")
            .body(axum::body::Body::from(value.to_string()))
            .unwrap()
    };
    let router = axum::Router::new()
        .route("/v1/responses", axum::routing::post(handle))
        .route("/v1/responses/compact", axum::routing::post(handle))
        .route("/v1/responses/input_tokens", axum::routing::post(handle))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (base, state, server)
}
async fn c3_seed(services: Arc<Services>, base: String) -> String {
    c3_seed_target(services, base, None).await
}
async fn c3_seed_target(
    services: Arc<Services>,
    base: String,
    target: Option<shellpilot_server::agent::Target>,
) -> String {
    save_test_model(&services, base);
    let profile = dispatch(
        services.clone(),
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    let mut config = profile[0]["config"].clone();
    config["contextWindow"] = json!(32768);
    config["provider"] = json!("openAiResponses");
    config["completionsPath"] = json!("responses");
    config["remoteCompaction"] = json!(true);
    dispatch(
        services.clone(),
        "agent/models",
        "POST",
        json!({"id":"model","userId":"default","revision":profile[0]["revision"],
        "update":{"config":config,"apiKey":{"action":"keep"}}}),
        Value::Null,
    )
    .await
    .unwrap();
    let session = services
        .agent
        .create_session("model".into(), "default".into())
        .await
        .unwrap();
    for i in 0..8 {
        let message = if i == 0 {
            "只读解释日志".into()
        } else {
            "u".repeat(1000)
        };
        let mut request = b5_request(&session, &format!("seed-{}", i), &message);
        request.terminal_session_id = target
            .as_ref()
            .map(|t| t.terminal_session_id.clone())
            .unwrap_or_default();
        services
            .agent
            .chat(
                request,
                target.clone(),
                &CancellationToken::new(),
                |_| async { Ok(()) },
            )
            .await
            .unwrap();
    }
    let profile = dispatch(
        services.clone(),
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    let mut config = profile[0]["config"].clone();
    config["contextWindow"] = json!(8192);
    config["compactPercent"] = json!(60);
    dispatch(
        services.clone(),
        "agent/models",
        "POST",
        json!({"id":"model","userId":"default","revision":profile[0]["revision"],
        "update":{"config":config,"apiKey":{"action":"keep"}}}),
        Value::Null,
    )
    .await
    .unwrap();
    session
}
#[tokio::test]
async fn c3_compaction_flows_through_native_channel_and_preserves_visible_history() {
    let (_dir, services) = services().await;
    let (base, model, server) = c3_model_server().await;
    let session = c3_seed(services.clone(), base).await;
    let request = b5_request(&session, "c3-native", "最新问题");
    let (sub, mut frames, run) = b5_start(services.clone(), request);
    let text = b5_frame(&mut frames).await;
    assert_eq!(text["requestId"], "c3-native");
    assert_eq!(text["payload"]["event"], "text");
    assert_eq!(text["payload"]["content"], "a".repeat(1000));
    acknowledge(&sub, text["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    assert_eq!(done["payload"]["event"], "done");
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    assert_eq!(model.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(model.streams.load(Ordering::SeqCst), 9);
    let history = b5_history(services.clone(), &session).await;
    assert!(history["session"]["checkpointId"].is_string());
    assert_eq!(history["turns"].as_array().unwrap().len(), 9);
    assert!(history["turns"]
        .as_array()
        .unwrap()
        .iter()
        .all(|turn| turn["state"] == "completed"));
    assert_eq!(history["turns"][8]["requestId"], "c3-native");
    assert!(!history.to_string().contains("native-opaque-do-not-display"));
    services.shutdown().await;
    server.abort();
}
#[tokio::test]
async fn c3_native_stop_during_summary_works_before_any_text_frame_or_turn_admission() {
    let (_dir, services) = services().await;
    let (base, model, server) = c3_model_server().await;
    let session = c3_seed(services.clone(), base).await;
    model.hold.store(true, Ordering::SeqCst);
    let (_, mut frames, run) = b5_start(
        services.clone(),
        b5_request(&session, "c3-stop", "最新问题"),
    );
    tokio::time::timeout(Duration::from_secs(3), model.arrived.notified())
        .await
        .unwrap();
    assert_eq!(b5_stop(services.clone(), &session, "c3-stop").await, true);
    let error = b5_frame(&mut frames).await;
    assert_eq!(error["sequence"], 0);
    assert_eq!(error["payload"]["code"], "AGENT_CANCELLED");
    assert_eq!(run.await.unwrap().unwrap_err().code, "AGENT_CANCELLED");
    let history = b5_history(services.clone(), &session).await;
    assert!(history["session"]["checkpointId"].is_null());
    assert_eq!(history["turns"].as_array().unwrap().len(), 8);
    assert_eq!(model.summaries.load(Ordering::SeqCst), 1);
    assert_eq!(model.streams.load(Ordering::SeqCst), 8);
    model.release.notify_one();
    services.shutdown().await;
    server.abort();
}

// Local SSH + real product Channel: a terminal close cannot become a successful compact/turn.
#[tokio::test]
async fn c4_native_disconnect_during_either_compaction_keeps_offline_discussion_and_legacy_scope() {
    for responses in [false, true] {
        let fixture = protocol::Fixture::new(Default::default()).await;
        let (store, connection) = fixture.saved(false);
        let services = Services::native(store, Default::default(), uuid::Uuid::new_v4());
        let opened = services
            .terminals
            .connect(protocol::open(&connection.connection_id))
            .await
            .unwrap();
        let target = Some(shellpilot_server::agent::Target {
            connection_id: connection.connection_id.clone(),
            terminal_session_id: opened.session_id.clone(),
        });
        let (base, model, server) = if responses {
            c3_model_server().await
        } else {
            c2_model_server().await
        };
        let session = if responses {
            c3_seed_target(services.clone(), base, target).await
        } else {
            c2_seed_target(services.clone(), base, target).await
        };
        model.hold.store(true, Ordering::SeqCst);
        let mut request = b5_request(&session, "c4-disconnect", "整理时断开");
        request.terminal_session_id = opened.session_id.clone();
        let (sub, mut frames, run) = b5_start(services.clone(), request);
        tokio::time::timeout(Duration::from_secs(3), model.arrived.notified())
            .await
            .unwrap();
        services.terminals.close(&opened.session_id);
        model.hold.store(false, Ordering::SeqCst);
        model.release.notify_one();
        // Text compaction continues after close; only live SSH operations would require a lease.
        let text = b5_frame(&mut frames).await;
        assert_eq!(text["payload"]["event"], "text");
        acknowledge(&sub, text["sequence"].as_u64().unwrap());
        let done = b5_frame(&mut frames).await;
        acknowledge(&sub, done["sequence"].as_u64().unwrap());
        run.await.unwrap().unwrap();
        let history = b5_history(services.clone(), &session).await;
        assert!(history["session"]["checkpointId"].is_string());
        assert_eq!(history["turns"].as_array().unwrap().len(), 9);
        assert_eq!(model.streams.load(Ordering::SeqCst), 9);
        let reopened = services
            .terminals
            .connect(protocol::open(&connection.connection_id))
            .await
            .unwrap();
        let mut retry = b5_request(&session, "c4-new-pty", "不允许更换目标");
        retry.terminal_session_id = reopened.session_id;
        let (_, mut frames, run) = b5_start(services.clone(), retry);
        assert_eq!(
            b5_frame(&mut frames).await["payload"]["code"],
            "AGENT_TARGET_MISMATCH"
        );
        assert_eq!(
            run.await.unwrap().unwrap_err().code,
            "AGENT_TARGET_MISMATCH"
        );
        let mut old = b5_request(&session, "c4-old-pty", "旧目标");
        old.terminal_session_id = opened.session_id.clone();
        let (sub, mut frames, run) = b5_start(services.clone(), old);
        let text = b5_frame(&mut frames).await;
        acknowledge(&sub, text["sequence"].as_u64().unwrap());
        let done = b5_frame(&mut frames).await;
        acknowledge(&sub, done["sequence"].as_u64().unwrap());
        run.await.unwrap().unwrap();
        // Replaying a completed seed is read-only and works after its original terminal has closed.
        let mut receipt = b5_request(&session, "seed-0", "只读解释日志");
        receipt.terminal_session_id = opened.session_id;
        let (sub, mut frames, replay) = b5_start(services.clone(), receipt);
        let done = b5_frame(&mut frames).await;
        assert_eq!(
            done["payload"],
            json!({"event":"done","content":"a".repeat(1000)})
        );
        acknowledge(&sub, done["sequence"].as_u64().unwrap());
        replay.await.unwrap().unwrap();
        assert_eq!(model.streams.load(Ordering::SeqCst), 10);
        services.shutdown().await;
        server.abort();
    }
}

#[tokio::test]
async fn scope_native_creation_family_owner_isolation_offline_stream_and_verified_reconnect() {
    let fixture = protocol::Fixture::new(Default::default()).await;
    let (store, connection) = fixture.saved(false);
    let services = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    let (base, requests, server) = b5_model_server().await;
    save_test_model(&services, base);
    let root = dispatch(
        services.clone(),
        "agent/create_session",
        "POST",
        json!({"agentId":"model","userId":"default"}),
        Value::Null,
    )
    .await
    .unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let opened = services
        .terminals
        .connect(protocol::open(&connection.connection_id))
        .await
        .unwrap();
    let body = json!({"agentId":"model","userId":"default","rootId":root,"terminalSessionId":opened.session_id});
    let a = dispatch(
        services.clone(),
        "agent/server_scope",
        "POST",
        body.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(a["scope"]["kind"], "server");
    assert!(a["scope"]["identity"]["hostKey"]
        .as_str()
        .unwrap()
        .starts_with("SHA256:"));
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/server_scope",
            "POST",
            body.clone(),
            Value::Null
        )
        .await
        .unwrap()["id"],
        a["id"]
    );
    let list = dispatch(
        services.clone(),
        "agent/scopes",
        "GET",
        Value::Null,
        json!({"agentId":"model","userId":"default","rootId":root}),
    )
    .await
    .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/scopes",
            "GET",
            Value::Null,
            json!({"agentId":"model","userId":"other","rootId":root})
        )
        .await
        .unwrap_err()
        .code,
        "AGENT_NOT_FOUND"
    );
    let session = a["id"].as_str().unwrap();
    services.terminals.close(&opened.session_id);
    let request = b5_request(session, "scope-offline", "continue");
    let (sub, mut frames, run) = b5_start(services.clone(), request.clone());
    let text = b5_frame(&mut frames).await;
    acknowledge(&sub, text["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    assert_eq!(
        b5_history(services.clone(), session).await["turns"][0]["state"],
        "completed"
    );
    let reopened = services
        .terminals
        .connect(protocol::open(&connection.connection_id))
        .await
        .unwrap();
    let resumed=dispatch(services.clone(),"agent/server_scope","POST",json!({"agentId":"model","userId":"default","rootId":root,"terminalSessionId":reopened.session_id}),Value::Null).await.unwrap();
    assert_eq!(resumed["id"], a["id"]);
    assert_eq!(requests.lock().unwrap().len(), 1);
    services.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn project_native_history_restores_without_new_chat_and_rebinds_after_workspace_restart() {
    let fixture = protocol::Fixture::new(Default::default()).await;
    let (store, connection) = fixture.saved(false);
    let services = Services::native(store.clone(), Default::default(), uuid::Uuid::new_v4());
    let (base, requests, server) = b5_model_server().await;
    save_test_model(&services, base);
    let project = dispatch(
        services.clone(),
        "agent/create_project",
        "POST",
        json!({"userId":"default","name":"项目 A","connectionId":connection.connection_id}),
        Value::Null,
    )
    .await
    .unwrap();
    let project_id = project["id"].as_str().unwrap().to_owned();
    let opened = services
        .terminals
        .connect(protocol::open(&connection.connection_id))
        .await
        .unwrap();
    let created=dispatch(services.clone(),"agent/project_chat","POST",json!({"userId":"default","projectId":project_id,"agentId":"model","terminalSessionId":opened.session_id}),Value::Null).await.unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    let mut request = b5_request(&id, "project-original", "keep the original constraints");
    request.terminal_session_id = opened.session_id.clone();
    let (sub, mut frames, run) = b5_start(services.clone(), request);
    let frame = b5_frame(&mut frames).await;
    acknowledge(&sub, frame["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    let history = b5_history(services.clone(), &id).await;
    services.shutdown().await;
    let resumed = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    let list = dispatch(
        resumed.clone(),
        "agent/projects",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    assert_eq!(list[0]["id"], project_id);
    let chats = dispatch(
        resumed.clone(),
        "agent/project_chats",
        "GET",
        Value::Null,
        json!({"userId":"default","projectId":project_id}),
    )
    .await
    .unwrap();
    assert_eq!(chats["items"].as_array().unwrap().len(), 1);
    assert_eq!(chats["items"][0]["sessionId"], id);
    assert_eq!(
        b5_history(resumed.clone(), &id).await["turns"],
        history["turns"]
    );
    let new_terminal = resumed
        .terminals
        .connect(protocol::open(&connection.connection_id))
        .await
        .unwrap();
    assert_ne!(new_terminal.session_id, opened.session_id);
    dispatch(resumed.clone(),"agent/project_terminal","POST",json!({"userId":"default","projectId":project_id,"terminalSessionId":new_terminal.session_id}),Value::Null).await.unwrap();
    let again = dispatch(
        resumed.clone(),
        "agent/project_chats",
        "GET",
        Value::Null,
        json!({"userId":"default","projectId":project_id}),
    )
    .await
    .unwrap();
    assert_eq!(again["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        dispatch(
            resumed.clone(),
            "agent/project_chats",
            "GET",
            Value::Null,
            json!({"userId":"other","projectId":project_id})
        )
        .await
        .unwrap_err()
        .code,
        "AGENT_NOT_FOUND"
    );
    assert_eq!(requests.lock().unwrap().len(), 1);
    // Explicit continuation uses the new PTY, same persisted chat, and original context.
    let mut next = b5_request(&id, "project-continue", "continue the previous constraints");
    next.terminal_session_id = new_terminal.session_id.clone();
    let (sub, mut frames, run) = b5_start(resumed.clone(), next);
    let frame = b5_frame(&mut frames).await;
    acknowledge(&sub, frame["sequence"].as_u64().unwrap());
    let done = b5_frame(&mut frames).await;
    acknowledge(&sub, done["sequence"].as_u64().unwrap());
    run.await.unwrap().unwrap();
    let continued = b5_history(resumed.clone(), &id).await;
    assert_eq!(continued["turns"].as_array().unwrap().len(), 2);
    assert_eq!(continued["turns"][1]["state"], "completed");
    {
        let captured = requests.lock().unwrap();
        assert_eq!(captured.len(), 2);
        assert!(captured[1]
            .to_string()
            .contains("keep the original constraints"));
        assert!(captured[1].to_string().contains(&new_terminal.session_id));
    }
    resumed.shutdown().await;
    server.abort();
}
