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

fn save_test_model(services: &Services, base_url: String) {
    use shellpilot_server::agent::provider::*;
    let config = ModelConfig {
        provider: ProviderKind::OpenAiCompatible,
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
