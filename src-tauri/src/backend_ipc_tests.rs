use super::*;
#[path = "../../../ai-ssh-terminal-server-rust/tests/support/mod.rs"]
#[allow(dead_code)]
mod protocol;
use std::sync::atomic::{AtomicU64, Ordering};

#[tokio::test]
async fn channel_ipc_saves_multiple_models_and_lists_stable_choices_without_credentials() {
    let (_dir,services)=services().await;
    save_test_model(&services,"http://127.0.0.1:1/v1/".into());
    let existing=dispatch(services.clone(),"agent/models","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    let original=existing.as_array().unwrap().iter().find(|p|p["id"]=="model").unwrap().clone();
    let body=json!({"id":"model","userId":"default","revision":original["revision"],"displayName":"Test provider","modelIds":[original["config"]["model"].clone(),json!("alternate-model")],"update":{"config":original["config"],"apiKey":{"action":"keep"}}});
    let channel=dispatch(services.clone(),"agent/model_channels","POST",body.clone(),Value::Null).await.unwrap();
    assert_eq!(channel["models"].as_array().unwrap().len(),2);assert_eq!(channel["models"][0]["id"],"model");
    let choices=dispatch(services.clone(),"agent/query_ai_agent_config_list","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    assert_eq!(choices.as_array().unwrap().iter().filter(|m|m["channelId"]=="model").count(),2);
    assert!(dispatch(services.clone(),"agent/model_channels","POST",body,Value::Null).await.is_err());
    let listed=dispatch(services.clone(),"agent/model_channels","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().iter().filter(|c|c["id"]=="model").count(),1);
    dispatch(services.clone(),"agent/model_channels","DELETE",json!({"userId":"default","id":"model","revision":channel["revision"]}),Value::Null).await.unwrap();
    let profiles=dispatch(services,"agent/models","GET",Value::Null,json!({"userId":"default"})).await.unwrap();assert!(profiles.as_array().unwrap().iter().all(|p|p["channelId"]!="model"));
}

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

#[tokio::test]
async fn agent_stream_future_fits_windows_stack() {
    let (_dir, services) = services().await;
    let request = b5_request("missing-session", "stack-budget", "fixture");
    let future = agent_stream_mode(services, request, subscription(), true, |_| Ok(()));
    let bytes = std::mem::size_of_val(&future);
    assert!(bytes < 32 * 1024, "IPC chat future occupies {bytes} bytes before polling");
    assert!(future.await.is_err());
}

#[test]
fn agent_stream_completes_and_logs_on_one_megabyte_stack() {
    std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let (dir, services) = services().await;
                    let (base, requests, server) = b5_model_server().await;
                    save_test_model(&services, base);
                    for tools in [false, true] {
                        let session = services.agent.create_session("model".into(), "default".into()).await.unwrap();
                        let id = format!("small-stack-{tools}");
                        let sub = subscription();
                        let ack = sub.clone();
                        let frames = Mutex::new(Vec::new());
                        agent_stream_mode(services.clone(), b5_request(&session, &id, "continue"), sub, tools, |frame| {
                            acknowledge(&ack, frame["sequence"].as_u64().unwrap());
                            frames.lock().unwrap().push(frame);
                            Ok(())
                        }).await.unwrap();
                        assert!(frames.lock().unwrap().iter().any(|frame| frame["payload"]["event"] == "done"));
                        let log = dir.path().join("logs/agent")
                            .join(chrono::Local::now().format("%Y-%m-%d").to_string())
                            .join(format!("{id}.log"));
                        let records: Vec<Value> = std::fs::read_to_string(log).unwrap().lines()
                            .map(|line| serde_json::from_str(line).unwrap()).collect();
                        assert_eq!(records.iter().filter(|row| row["event"] == "request.started").count(), 1);
                        assert!(records.iter().any(|row| row["event"] == "model.request_completed"));
                        assert_eq!(records.last().unwrap()["event"], "request.completed");
                        let messages: Vec<_> = records.iter().filter(|row| row["event"] == "conversation.message").collect();
                        assert_eq!(messages.len(), 2);
                        assert_eq!(messages[0]["fields"]["role"], "user");
                        assert_eq!(messages[0]["fields"]["message"], "continue");
                        assert_eq!(messages[1]["fields"]["role"], "assistant");
                        assert_eq!(messages[1]["fields"]["message"], "汉🙂");
                        assert_eq!(messages[1]["fields"]["state"], "completed");
                        assert!(messages[0]["fields"]["connectionName"].is_null());
                        assert_eq!(messages[0]["fields"]["modelId"], "mock-model");
                        let replay_ack = subscription();
                        let replay_sub = replay_ack.clone();
                        agent_stream_mode(services.clone(), b5_request(&session, &id, "continue"), replay_sub, tools, |frame| {
                            acknowledge(&replay_ack, frame["sequence"].as_u64().unwrap());
                            Ok(())
                        }).await.unwrap();
                        let replay_log = dir.path().join("logs/agent")
                            .join(chrono::Local::now().format("%Y-%m-%d").to_string()).join(format!("{id}.log"));
                        assert_eq!(std::fs::read_to_string(replay_log).unwrap().lines()
                            .map(|line| serde_json::from_str::<Value>(line).unwrap())
                            .filter(|row| row["event"] == "conversation.message").count(), 2);
                    }
                    assert_eq!(requests.lock().unwrap().len(), 2);
                    services.shutdown().await;
                    server.abort();
                });
        }).unwrap().join().unwrap();
}

#[tokio::test]
async fn e3_extension_dispatch_keeps_config_revision_and_approval_ownership() {
    let (_dir, services)=services().await;
    let initial=dispatch(services.clone(),"agent/extensions_settings","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    assert_eq!(initial["revision"],0);
    assert_eq!(initial["config"]["executionLimits"]["modelRounds"],32);
    let body=json!({"userId":"default","revision":0,"config":{"servers":[{"name":"local","enabled":false,"transport":"stdio","command":"fixture","args":[],"env":["MCP_TOKEN"]},{"name":"baidu-search","enabled":false,"transport":"sse","url":"http://appbuilder.baidu.com/v2/ai_search/mcp/sse?api_key=Bearer+fixture","bearerEnv":"","timeoutSeconds":300}],"skillRoots":[],"subAgents":true,"executionLimits":{"modelRounds":48,"toolCalls":256,"childModelRounds":36,"childToolCalls":96,"maxChildTasks":4}}});
    let saved=dispatch(services.clone(),"agent/extensions_settings","POST",body.clone(),Value::Null).await.unwrap();
    assert_eq!(saved["revision"],1);assert_eq!(saved["config"]["servers"][0]["transport"],"stdio");
    assert_eq!(saved["config"]["executionLimits"],body["config"]["executionLimits"]);
    let readback=dispatch(services.clone(),"agent/extensions_settings","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    assert_eq!(readback["config"]["executionLimits"],body["config"]["executionLimits"]);
    assert_eq!(readback["config"]["servers"],body["config"]["servers"]);
    assert!(dispatch(services.clone(),"agent/extensions_settings","POST",body,Value::Null).await.is_err());
    let other=dispatch(services.clone(),"agent/extensions_settings","GET",Value::Null,json!({"userId":"other"})).await.unwrap();assert_eq!(other["revision"],0);
    save_test_model(&services,"http://127.0.0.1:1/v1/".into());
    let chat=dispatch(services.clone(),"agent/create_session","POST",json!({"userId":"default","agentId":"model"}),Value::Null).await.unwrap();
    let owned=json!({"userId":"default","agentId":"model","sessionId":chat["sessionId"]});
    assert_eq!(dispatch(services.clone(),"agent/extensions_requests","GET",Value::Null,owned.clone()).await.unwrap(),json!([]));
    let mut foreign=owned.clone();foreign["userId"]=json!("other");
    let error=dispatch(services.clone(),"agent/extensions_requests","GET",Value::Null,foreign.clone()).await.unwrap_err();assert_eq!(error.code,"AGENT_NOT_FOUND");
    foreign["id"]=json!("unowned");foreign["allow"]=json!(true);
    let error=dispatch(services.clone(),"agent/extensions_decision","POST",foreign,Value::Null).await.unwrap_err();assert_eq!(error.code,"AGENT_NOT_FOUND");
    services.shutdown().await;
}

#[cfg(windows)]
#[tokio::test]
async fn mcp_client_token_dispatch_saves_redacted_credentials_and_supports_keep_and_clear() {
    let (_dir, services)=services().await;
    let body=json!({"userId":"default","revision":0,"config":{"servers":[{"name":"baidu-search","enabled":false,"transport":"streamableHttp","url":"https://example.com/mcp","bearerEnv":"","bearerToken":{"action":"set","value":"fixture-client-token/a+b.c"}}]}});
    let saved=dispatch(services.clone(),"agent/extensions_settings","POST",body,Value::Null).await.unwrap();
    assert_eq!(saved["config"]["servers"][0]["bearerTokenConfigured"],true);
    assert!(saved["config"]["servers"][0].get("bearerToken").is_none());
    assert!(!saved.to_string().contains("fixture-client-token"));
    let readback=dispatch(services.clone(),"agent/extensions_settings","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    assert_eq!(readback,saved);
    let mut keep=readback; keep["userId"]=json!("default");
    let kept=dispatch(services.clone(),"agent/extensions_settings","POST",keep,Value::Null).await.unwrap();
    assert_eq!(kept["config"]["servers"][0]["bearerTokenConfigured"],true);
    let mut clear=kept; clear["userId"]=json!("default"); clear["config"]["servers"][0]["bearerToken"]=json!({"action":"clear"});
    let cleared=dispatch(services.clone(),"agent/extensions_settings","POST",clear,Value::Null).await.unwrap();
    assert!(cleared["config"]["servers"][0].get("bearerTokenConfigured").is_none());
    let other=dispatch(services.clone(),"agent/extensions_settings","GET",Value::Null,json!({"userId":"other"})).await.unwrap();
    assert_eq!(other["config"]["servers"],json!([]));
    services.shutdown().await;
}

#[cfg(windows)]
#[tokio::test]
async fn json_mcp_dispatch_preserves_metadata_and_redacts_headers_and_stdio_environment() {
    let (_dir,services)=services().await;
    let body=json!({"userId":"default","revision":0,"config":{"servers":[{"name":"search","description":"实时搜索","enabled":false,"transport":"streamableHttp","url":"https://example.com/mcp","connectionValues":{"headers":{"Authorization":"Bearer fixture-json-token"},"env":{}}},{"name":"local","enabled":false,"transport":"stdio","command":"node","args":["server.js"],"env":[],"connectionValues":{"headers":{},"env":{"TOKEN":"fixture-env-key"}}}]}});
    let saved=dispatch(services.clone(),"agent/extensions_settings","POST",body,Value::Null).await.unwrap();
    assert_eq!(saved["config"]["servers"][0]["description"],"实时搜索");
    assert_eq!(saved["config"]["servers"][0]["savedHeaders"],json!(["authorization"]));
    assert_eq!(saved["config"]["servers"][1]["savedEnv"],json!(["TOKEN"]));
    assert!(!saved.to_string().contains("fixture-json-token"));assert!(!saved.to_string().contains("fixture-env-key"));
    let readback=dispatch(services.clone(),"agent/extensions_settings","GET",Value::Null,json!({"userId":"default"})).await.unwrap();assert_eq!(saved,readback);
    let mut keep=readback;keep["userId"]=json!("default");
    keep["config"]["servers"][0]["connectionValues"]=json!({"headers":{"Authorization":"__SHELLPILOT_SAVED__"},"env":{}});
    keep["config"]["servers"][1]["connectionValues"]=json!({"headers":{},"env":{"TOKEN":"__SHELLPILOT_SAVED__"}});
    let kept=dispatch(services.clone(),"agent/extensions_settings","POST",keep,Value::Null).await.unwrap();
    assert_eq!(kept["config"]["servers"],saved["config"]["servers"]);
    let mut remove=kept;remove["userId"]=json!("default");remove["config"]["servers"]=json!([]);
    assert_eq!(dispatch(services.clone(),"agent/extensions_settings","POST",remove,Value::Null).await.unwrap()["config"]["servers"],json!([]));
    services.shutdown().await;
}

#[tokio::test]
async fn delete_chat_dispatch_removes_owned_history_without_deleting_models() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let created = dispatch(
        services.clone(),
        "agent/create_session",
        "POST",
        json!({"agentId":"model","userId":"default"}),
        Value::Null,
    )
    .await
    .unwrap();
    let body = json!({"agentId":"model","userId":"default","sessionId":created["sessionId"]});
    let mut wrong = body.clone();
    wrong["userId"] = json!("other");
    let error = dispatch(
        services.clone(),
        "agent/delete_chat",
        "POST",
        wrong,
        Value::Null,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "AGENT_NOT_FOUND");
    assert!(dispatch(
        services.clone(),
        "agent/delete_chat",
        "POST",
        body.clone(),
        Value::Null
    )
    .await
    .unwrap()
    .is_null());
    let error = dispatch(
        services.clone(),
        "agent/chat_history",
        "GET",
        Value::Null,
        body,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "AGENT_NOT_FOUND");
    let models = dispatch(
        services,
        "agent/models",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    assert_eq!(models.as_array().unwrap().len(), 1);
}
async fn services() -> (tempfile::TempDir, Arc<Services>) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        Arc::new(shellpilot_server::store::Store::open(&dir.path().join("db.sqlite3")).unwrap());
    let services = Services::native(store, Default::default(), uuid::Uuid::new_v4());
    (dir, services)
}

#[tokio::test]
async fn delete_project_dispatch_preserves_chats_and_ssh_configuration() {
    use shellpilot_server::agent::{Payload, Repository, ServerIdentity, Target};
    let (_dir, services) = services().await;
    services
        .store
        .save(
            shellpilot_server::model::ConnectionRequest {
                connection_id: Some("saved-server".into()),
                connection_name: "saved".into(),
                host: "host".into(),
                port: 22,
                username: "user".into(),
                user_id: Some("default".into()),
                strict_host_key_check: Some(false),
                ..Default::default()
            },
            false,
        )
        .unwrap();
    let repo = Repository::new(services.store.clone());
    let p = repo
        .create_project("default", "待移除", "saved-server")
        .unwrap();
    let chat = repo
        .create_project_chat(
            &p.id,
            "default",
            "model",
            &Target {
                connection_id: "saved-server".into(),
                terminal_session_id: "terminal".into(),
            },
            ServerIdentity {
                host: "host".into(),
                port: 22,
                username: "user".into(),
                host_key: "test-key".into(),
            },
        )
        .unwrap();
    repo.append(
        &chat.id,
        "default",
        0,
        "message",
        Payload::UserMessage {
            text: "项目记录".into(),
        },
    )
    .unwrap();
    let wrong = dispatch(
        services.clone(),
        "agent/delete_project",
        "POST",
        json!({"userId":"other","projectId":p.id}),
        Value::Null,
    )
    .await
    .unwrap_err();
    assert_eq!(wrong.code, "AGENT_NOT_FOUND");
    assert_eq!(repo.projects("default").unwrap().len(), 1);
    dispatch(
        services.clone(),
        "agent/delete_project",
        "POST",
        json!({"userId":"default","projectId":p.id}),
        Value::Null,
    )
    .await
    .unwrap();
    assert!(repo.projects("default").unwrap().is_empty());
    assert_eq!(
        repo.session(&chat.id, "default")
            .unwrap()
            .scope
            .unwrap()
            .origin_terminal_id
            .as_deref(),
        Some("terminal")
    );
    assert_eq!(repo.events(&chat.id, "default", 0, 200).unwrap().len(), 1);
    assert_eq!(
        repo.project_chats("default", None, "").unwrap().items[0].session_id,
        chat.id
    );
    assert!(services.store.get("saved-server").is_ok());
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
async fn change_model_dispatch_keeps_conversation_and_checks_owner_and_revision() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let models = shellpilot_server::agent::provider::ModelRepository::new(services.store.clone());
    let profile = models.get("model", "default").unwrap();
    models.save("second", "default", 0, shellpilot_server::agent::provider::ModelConfigUpdate {
        config: profile.config,
        api_key: shellpilot_server::agent::provider::KeyChange::Set {
            value: shellpilot_server::agent::provider::SecretKey::new("fixture-key").unwrap(),
        },
    }).unwrap();
    let id = services.agent.create_session("model".into(), "default".into()).await.unwrap();
    let before = services.agent.history("model".into(), "default".into(), id.clone(), 0, 20).await.unwrap().session;
    let request = json!({"userId":"default","agentId":"model","modelId":"second","sessionId":id,"revision":before.revision});
    let mut foreign = request.clone(); foreign["userId"] = json!("other");
    assert!(dispatch(services.clone(), "agent/change_model", "POST", foreign, Value::Null).await.is_err());
    let mut stale = request.clone(); stale["revision"] = json!(before.revision + 99);
    assert!(dispatch(services.clone(), "agent/change_model", "POST", stale, Value::Null).await.is_err());
    let mut missing = request.clone(); missing.as_object_mut().unwrap().remove("revision");
    assert!(dispatch(services.clone(), "agent/change_model", "POST", missing, Value::Null).await.is_err());
    let changed = dispatch(services.clone(), "agent/change_model", "POST", request, Value::Null).await.unwrap();
    assert_eq!(changed["id"], id);
    assert_eq!(changed["agentId"], "second");
    let after = services.agent.history("second".into(), "default".into(), id, 0, 20).await.unwrap().session;
    assert_eq!(after.scope, before.scope);
    assert_eq!(after.task, before.task);
    assert_eq!(after.revision, before.revision + 1);
    services.shutdown().await;
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
    // Explicit model URL edits retain the encrypted key by the repository contract.
    let moved = dispatch(services.clone(), "agent/models", "POST", request.clone(), Value::Null).await.unwrap();
    assert_eq!(moved["apiKeyConfigured"], true);
    assert!(!moved.to_string().contains("fake-test-key"));
    request["revision"] = moved["revision"].clone();
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
        supplier: None,
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
    let metadata_ack = sub.clone();
    let operation = tokio::spawn(agent_stream(services, request, stream, move |e| {
        if e["payload"]["event"] == "context" {
            acknowledge(&metadata_ack, e["sequence"].as_u64().unwrap());
            return Ok(());
        }
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
    let metadata_ack = sub.clone();
    let operation = tokio::spawn(agent_stream(services.clone(), request, stream, move |e| {
        if e["payload"]["event"] == "context" {
            acknowledge(&metadata_ack, e["sequence"].as_u64().unwrap());
            return Ok(());
        }
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
    let metadata_ack = sub.clone();
    let run = tokio::spawn(agent_stream(services, request, stream, move |event| {
        if event["payload"]["event"] == "context" {
            acknowledge(&metadata_ack, event["sequence"].as_u64().unwrap());
            return Ok(());
        }
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
    let (dir, services) = services().await;
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
    let log = dir.path().join("logs/agent")
        .join(chrono::Local::now().format("%Y-%m-%d").to_string())
        .join("b5-protocol-failure.log");
    let rows: Vec<Value> = std::fs::read_to_string(log).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect();
    let messages: Vec<_> = rows.iter().filter(|row| row["event"] == "conversation.message").collect();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["fields"]["state"], "failed");
    assert_eq!(messages[1]["fields"]["message"], "汉🙂");
    assert!(!serde_json::to_string(&rows).unwrap().contains("provider-private-error"));
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
                "retainedUserFacts":[],"evidenceEventIds":[source["availableEvidenceEventIds"].as_array().unwrap().last().unwrap()]}).to_string();
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
async fn c5_context_status_uses_real_channel_events_and_owner_scoped_persisted_measurements() {
    let (_dir, services) = services().await;
    let (base, model, server) = c2_model_server().await;
    let session = c2_seed(services.clone(), base).await;
    let sub = subscription();
    let stream = sub.clone();
    let (tx, mut frames) = tokio::sync::mpsc::channel(4);
    let run = tokio::spawn(agent_stream(
        services.clone(),
        b5_request(&session, "c5-native", "查看上下文"),
        stream,
        move |frame| tx.try_send(frame).map_err(|_| ()),
    ));
    let mut states = Vec::new();
    loop {
        let frame = b5_frame(&mut frames).await;
        assert_eq!(frame["requestId"], "c5-native");
        if frame["payload"]["event"] == "context" {
            states.push(frame["payload"]["status"].clone());
        }
        acknowledge(&sub, frame["sequence"].as_u64().unwrap());
        if frame["payload"]["event"] == "done" {
            break;
        }
    }
    run.await.unwrap().unwrap();
    assert!(states.iter().any(|state| state["phase"] == "running"));
    assert!(states
        .iter()
        .any(|state| state["phase"] == "succeeded" && state["compactionCount"] == 1));
    let status = dispatch(
        services.clone(),
        "agent/context_status",
        "GET",
        Value::Null,
        json!({"agentId":"model","userId":"default","sessionId":session}),
    )
    .await
    .unwrap();
    assert_eq!(status["phase"], "succeeded");
    assert_eq!(status["usage"]["source"], "estimated");
    assert_eq!(status["compactionCount"], 1);
    assert!(status["usage"]["inputTokens"].as_u64().unwrap() > 0);
    assert!(dispatch(
        services.clone(),
        "agent/context_status",
        "GET",
        Value::Null,
        json!({"agentId":"model","userId":"other","sessionId":session})
    )
    .await
    .is_err());
    assert_eq!(model.summaries.load(Ordering::SeqCst), 1);
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

#[tokio::test]
async fn d5_native_channel_waits_for_human_approval_executes_bound_ssh_and_restores_outputs() {
    use shellpilot_server::agent::provider::*;
    let fixture = protocol::Fixture::new(protocol::Spec::default()).await;
    let (_dir, services) = services().await;
    let connection = services.store.save(fixture.request(false), false).unwrap();
    let terminal = services
        .terminals
        .connect(protocol::open(&connection.connection_id))
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicU64::new(0));
    let count = calls.clone();
    let stream_release = Arc::new(tokio::sync::Notify::new());
    let release = stream_release.clone();
    let router=axum::Router::new().route("/chat/completions",axum::routing::post(move|axum::Json(body):axum::Json<Value>|{let count=count.clone();let release=release.clone();async move{
        if body["stream"]==true && body.get("tools").is_none() {
            let messages=body["messages"].to_string();assert!(messages.contains("历史工具证据"));assert!(messages.contains("__exec_chunked__"));assert!(messages.contains("textOnly"));
            let events=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"index":0,"delta":{"content":"离线分析历史输出"},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}));
            return axum::response::Response::builder().header("content-type","text/event-stream").body(axum::body::Body::from(events)).unwrap();
        }
        let tools = body["tools"].as_array().unwrap();
        assert!(tools.iter().any(|tool| tool["function"]["name"] == "ssh_execute"));
        assert!(tools.iter().any(|tool| tool["function"]["name"] == "read_tool_output"));
        assert!(tools.iter().all(|tool| tool["type"] == "function"));
        assert_eq!(body["stream"],true);
        assert!(body["messages"].to_string().contains("E1-native-evidence"));
        let index=count.fetch_add(1,Ordering::SeqCst);
        if index==0 {
            // Compatibility: this first response ignores stream=true and sends JSON once.
            return axum::response::IntoResponse::into_response(axum::Json(json!({"choices":[{"index":0,"message":{"role":"assistant","content":"先查看日志","tool_calls":[{"id":"ipc-command","type":"function","function":{"name":"ssh_execute","arguments":"{\"command\":\"__exec_chunked__\",\"timeoutSeconds\":2}"}}]},"finish_reason":"tool_calls"}]})));
        }
        assert!(index<=2);
        let messages=body["messages"].as_array().unwrap();assert!(messages.iter().any(|m|m["role"]=="tool"&&m["tool_call_id"]=="ipc-command"));
        let first=format!("data: {}\n\n",json!({"choices":[{"index":0,"delta":{"content":if index==1{"已读取"}else{"未完成的部分回复"}},"finish_reason":null}]}));
        let rest=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"index":0,"delta":{"content":"绑定服务器日志"},"finish_reason":null}]}),json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}));
        let chunks=futures_util::stream::unfold(0,move|step|{let release=release.clone();let first=first.clone();let rest=rest.clone();async move{
            let data=match step{0=>first,1=>{release.notified().await;rest},_=>return None};
            Some((Ok::<_,std::convert::Infallible>(data.into_bytes()),step+1))
        }});
        axum::response::Response::builder().header("content-type","text/event-stream").body(axum::body::Body::from_stream(chunks)).unwrap()
    }}));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    save_test_model(&services, address);
    let models = ModelRepository::new(services.store.clone());
    let mut config = models.get("model", "default").unwrap();
    config.config.capabilities.tool_calls = true;
    models
        .save(
            "model",
            "default",
            config.revision,
            ModelConfigUpdate {
                config: config.config,
                api_key: KeyChange::Keep,
            },
        )
        .unwrap();
    let root = services
        .agent
        .create_general_session("model".into(), "default".into())
        .await
        .unwrap();
    let session=dispatch(services.clone(),"agent/server_scope","POST",json!({"agentId":"model","userId":"default","rootId":root.id,"terminalSessionId":terminal.session_id}),Value::Null).await.unwrap();
    let id = session["id"].as_str().unwrap().to_owned();
    let bound=dispatch(services.clone(),"agent/execution_bind","POST",json!({"agentId":"model","userId":"default","sessionId":id,"terminalSessionId":terminal.session_id}),Value::Null).await.unwrap();
    assert_eq!(
        bound["task"]["target"]["terminalSessionId"],
        terminal.session_id
    );
    let attachment = services
        .files
        .clone()
        .upload_reader(
            "evidence.txt".into(),
            "text/plain".into(),
            std::io::Cursor::new(b"E1-native-evidence".to_vec()),
        )
        .await
        .unwrap();
    let request:shellpilot_server::agent::chat::Request=serde_json::from_value(json!({"requestId":"ipc-d5-turn","agentId":"model","userId":"default","sessionId":id,"terminalSessionId":terminal.session_id,"message":"查看日志","attachments":[{"fileId":attachment.file_id}]})).unwrap();
    let params = json!({"agentId":"model","userId":"default","sessionId":id});
    let sub = subscription();
    let stream = sub.clone();
    let copy = services.clone();
    let r = request.clone();
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let run = tokio::spawn(agent_stream_mode(copy, r, stream, true, move |event| {
        tx.send(event).map_err(|_| ())
    }));
    let mut tool_call = false;
    let mut tool_result = false;
    let mut done = false;
    let mut text = String::new();
    tokio::time::timeout(Duration::from_secs(12),async{
        while let Some(frame)=events.recv().await{
            assert_eq!(frame["requestId"],"ipc-d5-turn");
            let sequence=frame["sequence"].as_u64().unwrap();assert!(sequence>0);acknowledge(&sub,sequence);
            match frame["payload"]["event"].as_str().unwrap(){
                "tool_call"=>{
                    tool_call=true;assert_eq!(frame["payload"]["command"],"__exec_chunked__");
                    let receipt=loop{let list=dispatch(services.clone(),"agent/execution_requests","GET",Value::Null,params.clone()).await.unwrap();if let Some(r)=list.as_array().unwrap().iter().find(|r|r["state"]=="pending"){break r.clone();}tokio::time::sleep(Duration::from_millis(10)).await;};
                    assert!(fixture.stats.execs.lock().unwrap().is_empty());
                    assert_eq!(receipt["binding"]["tool"]["target"]["connectionId"],connection.connection_id);
                    let mut forged=params.clone();forged["userId"]=json!("intruder");
                    assert!(dispatch(services.clone(),"agent/execution_requests","GET",Value::Null,forged).await.is_err());
                    dispatch(services.clone(),"agent/execution_decision","POST",json!({"agentId":"model","userId":"default","sessionId":id,"id":receipt["id"],"action":"approveOnce"}),Value::Null).await.unwrap();
                },
                "tool_result"=>{tool_result=true;assert_eq!(frame["payload"]["status"],"success");},
                "text"=>{let content=frame["payload"]["content"].as_str().unwrap();text.push_str(content);if content=="已读取"{assert!(tool_result);assert!(!run.is_finished());stream_release.notify_one();}},
                "done"=>{done=true;assert_eq!(frame["payload"]["content"],text);break;},
                "context"=>{},other=>panic!("unexpected native frame {other}")
            }
        }
    }).await.unwrap();
    run.await.unwrap().unwrap();
    assert!(tool_call && tool_result && done);
    assert_eq!(text, "先查看日志\n\n已读取绑定服务器日志");
    assert_eq!(fixture.stats.execs.lock().unwrap().len(), 1);
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
    assert_eq!(
        history["turns"][0]["resultText"],
        "先查看日志\n\n已读取绑定服务器日志"
    );
    let raw = shellpilot_server::agent::Repository::new(services.store.clone())
        .events(&id, "default", 0, 200)
        .unwrap();
    let replies = raw
        .iter()
        .filter_map(|event| {
            if let shellpilot_server::agent::Payload::AssistantMessage { text } = &event.payload {
                Some(text.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(replies, vec!["先查看日志", "已读取绑定服务器日志"]);
    let result = &history["turns"][0]["toolEvents"][1]["payload"];
    let output = result["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["channel"] == "stdout")
        .unwrap();
    let mut range = params.clone();
    range["outputId"] = output["id"].clone();
    range["offset"] = json!("65534");
    range["limit"] = json!("512");
    let bytes = dispatch(
        services.clone(),
        "agent/execution_output",
        "GET",
        Value::Null,
        range.clone(),
    )
    .await
    .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(bytes["bytes"].clone()).unwrap();
    assert_eq!(
        bytes,
        (65534..66046).map(|i| (i % 251) as u8).collect::<Vec<_>>()
    );
    let preview = dispatch(
        services.clone(),
        "agent/attachment",
        "GET",
        Value::Null,
        json!({"agentId":"model","userId":"default","sessionId":id,"fileId":attachment.file_id}),
    )
    .await
    .unwrap();
    assert_eq!(preview["text"], "E1-native-evidence");
    assert!(dispatch(services.clone(),"agent/attachment","GET",Value::Null,json!({"agentId":"wrong-model","userId":"default","sessionId":id,"fileId":attachment.file_id})).await.is_err());
    // A second tool-enabled turn is cancelled while its provider is still streaming.
    let mut cancelled = request.clone();
    cancelled.request_id = "ipc-d5-stream-cancel".into();
    let cancel_sub = subscription();
    let ack = cancel_sub.clone();
    let (tx, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let cancelled_run = tokio::spawn(agent_stream_mode(
        services.clone(),
        cancelled,
        cancel_sub.clone(),
        true,
        move |frame| tx.send(frame).map_err(|_| ()),
    ));
    tokio::time::timeout(Duration::from_secs(8),async{
        loop{let frame=frames.recv().await.unwrap();let sequence=frame["sequence"].as_u64().unwrap();
            if frame["payload"]["event"]=="error"{assert_eq!(frame["payload"]["code"],"AGENT_CANCELLED");break;}
            assert!(sequence>0,"{frame}");acknowledge(&ack,sequence);
            if frame["payload"]["event"]=="text"{assert_eq!(frame["payload"]["content"],"未完成的部分回复");
                dispatch(services.clone(),"agent/stop_chat","POST",json!({"agentId":"model","userId":"default","sessionId":id,"requestId":"ipc-d5-stream-cancel"}),Value::Null).await.unwrap();
            }
        }
    }).await.unwrap();
    assert_eq!(
        cancelled_run.await.unwrap().unwrap_err().code,
        "AGENT_CANCELLED"
    );
    let retained = b5_history(services.clone(), &id).await;
    assert_eq!(retained["turns"][1]["partialText"], "未完成的部分回复");
    assert_eq!(retained["turns"][1]["state"], "cancelled");
    assert!(retained["turns"][1]["resultText"].is_null());
    assert_eq!(fixture.stats.execs.lock().unwrap().len(), 1);
    services.terminals.shutdown().await;
    let mut offline = request.clone();
    offline.request_id = "ipc-d5-offline".into();
    offline.terminal_session_id = String::new();
    offline.message = "根据已有记录分析，无需执行".into();
    let target = services.agent.text_target(offline.clone()).await.unwrap();
    services
        .agent
        .chat_desktop(
            offline,
            target,
            false,
            &CancellationToken::new(),
            |_| async { Ok(()) },
        )
        .await
        .unwrap();
    assert_eq!(fixture.stats.execs.lock().unwrap().len(), 1);
    server.abort();
    let sub = subscription();
    let ack = sub.clone();
    agent_stream_mode(services.clone(), request, sub, true, move |frame| {
        assert_eq!(frame["payload"]["event"], "done");
        acknowledge(&ack, frame["sequence"].as_u64().unwrap());
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.stats.execs.lock().unwrap().len(), 1);
    dispatch(
        services.clone(),
        "agent/execution_output",
        "GET",
        Value::Null,
        range,
    )
    .await
    .unwrap();
    services.shutdown().await;
}

#[tokio::test]
async fn attachment_input_clipboard_image_uploads_native_bytes_and_returns_a_bounded_preview() {
    let (_dir, services) = services().await;
    let bytes =
        attachment_input::encode_clipboard_image(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
    assert!(bytes.starts_with(b"\x89PNG"));
    let mut events = vec![];
    attachment_input::upload_image(&services, bytes.clone(), 4, 20_000_000, |event| {
        events.push(event);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["type"], "preparing");
    assert_eq!(events[1]["type"], "uploaded");
    assert_eq!(events[0]["id"], events[1]["id"]);
    let file = &events[1]["file"];
    assert_eq!(file["size"], bytes.len());
    assert!(file["previewUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
    let id = file["fileId"].as_str().unwrap();
    let (_, mut source) = services.files.open_attachment(id).await.unwrap();
    let mut stored = vec![];
    tokio::io::AsyncReadExt::read_to_end(&mut source, &mut stored)
        .await
        .unwrap();
    assert_eq!(stored, bytes);
    assert_eq!(
        attachment_input::preview(&services, id).await.unwrap(),
        file["previewUrl"]
    );
    services.files.delete(id).await.unwrap();
    assert!(attachment_input::preview(&services, id).await.is_err());
}
#[tokio::test]
async fn attachment_input_copied_files_validate_the_entire_batch_before_uploading() {
    let (dir, services) = services().await;
    let text = dir.path().join("复制文件.txt");
    let image = dir.path().join("截图.png");
    let office = dir.path().join("unsupported.docx");
    std::fs::write(&text, b"copied evidence").unwrap();
    std::fs::write(
        &image,
        attachment_input::encode_clipboard_image(1, 1, &[1, 2, 3, 255]).unwrap(),
    )
    .unwrap();
    std::fs::write(&office, b"office").unwrap();
    let mut events = vec![];
    assert!(attachment_input::upload_paths(
        &services,
        vec![text.clone(), office],
        4,
        20_000_000,
        |event| {
            events.push(event);
            Ok(())
        }
    )
    .await
    .is_err());
    assert!(events.is_empty());
    assert_eq!(services.files.stats().await.unwrap().file_count, 0);
    assert!(attachment_input::upload_paths(
        &services,
        vec![text.clone(), image.clone()],
        1,
        20_000_000,
        |_| Ok(())
    )
    .await
    .is_err());
    assert!(
        attachment_input::upload_paths(&services, vec![text.clone()], 4, 2, |_| Ok(()))
            .await
            .is_err()
    );
    attachment_input::upload_paths(&services, vec![text, image], 4, 20_000_000, |event| {
        events.push(event);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(events.len(), 4);
    assert_eq!(events[0]["type"], "preparing");
    assert_eq!(events[1]["type"], "preparing");
    assert_eq!(events[0]["id"], events[2]["id"]);
    assert_eq!(events[1]["id"], events[3]["id"]);
    assert_eq!(events[2]["file"]["fileName"], "复制文件.txt");
    assert!(events[2]["file"]["previewUrl"].is_null());
    assert!(events[3]["file"]["previewUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
}
#[test]
fn attachment_input_clipboard_images_reject_invalid_dimensions_and_buffers() {
    assert!(attachment_input::encode_clipboard_image(0, 1, &[]).is_err());
    assert!(attachment_input::encode_clipboard_image(16385, 1, &[]).is_err());
    assert!(attachment_input::encode_clipboard_image(16384, 16384, &[]).is_err());
    assert!(attachment_input::encode_clipboard_image(2, 2, &[0; 4]).is_err());
}

#[tokio::test]
async fn memory_dispatch_has_native_owner_revision_and_provenance_checks() {
    let (_dir, services) = services().await;
    save_test_model(&services, "http://127.0.0.1:1/v1/".into());
    let created = dispatch(
        services.clone(),
        "agent/create_session",
        "POST",
        json!({"agentId":"model","userId":"default"}),
        Value::Null,
    )
    .await
    .unwrap();
    let scope = json!({"agentId":"model","userId":"default","sessionId":created["sessionId"]});
    let memory = json!({"id":uuid::Uuid::new_v4().to_string(),"revision":0,"title":"语言偏好","content":"中文回答","kind":"preference","scope":"global","enabled":true});
    let mut body = scope.clone();
    body["memory"] = memory.clone();
    let saved = dispatch(
        services.clone(),
        "agent/memories",
        "POST",
        body.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(saved["source"]["sessionId"], scope["sessionId"]);
    assert_eq!(saved["revision"], 1);
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/memories",
            "POST",
            body.clone(),
            Value::Null
        )
        .await
        .unwrap_err()
        .code,
        "AGENT_MEMORY_CHANGED"
    );
    let list = dispatch(
        services.clone(),
        "agent/memories",
        "GET",
        Value::Null,
        scope.clone(),
    )
    .await
    .unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let mut foreign = scope.clone();
    foreign["userId"] = json!("other");
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/memories",
            "GET",
            Value::Null,
            foreign
        )
        .await
        .unwrap_err()
        .code,
        "AGENT_NOT_FOUND"
    );
    body["memory"]["target"] = json!({"host":"spoofed"});
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/memories",
            "POST",
            body,
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    let mut deletion = scope;
    deletion["id"] = saved["id"].clone();
    deletion["revision"] = saved["revision"].clone();
    dispatch(
        services.clone(),
        "agent/memories",
        "DELETE",
        deletion.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(
        dispatch(services, "agent/memories", "GET", Value::Null, deletion)
            .await
            .unwrap()["items"],
        json!([])
    );
}

#[tokio::test]
async fn memory_dispatch_before_chat_needs_no_model_and_keeps_history_empty() {
    let (_dir, services) = services().await;
    let scope = json!({"userId":"default"});
    let memory = json!({"id":uuid::Uuid::new_v4().to_string(),"revision":0,"title":"语言偏好","content":"中文回答","kind":"preference","scope":"global","enabled":true});
    let mut body = scope.clone();
    body["memory"] = memory;
    let saved = dispatch(
        services.clone(),
        "agent/memories",
        "POST",
        body,
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(saved["source"]["sessionId"], "");
    assert_eq!(saved["source"]["agentId"], "");
    let list = dispatch(
        services.clone(),
        "agent/memories",
        "GET",
        Value::Null,
        scope.clone(),
    )
    .await
    .unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["applicable"], true);
    assert!(list["target"].is_null());
    let foreign = dispatch(
        services.clone(),
        "agent/memories",
        "GET",
        Value::Null,
        json!({"userId":"other"}),
    )
    .await
    .unwrap();
    assert_eq!(foreign["items"], json!([]));
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/memories",
            "GET",
            Value::Null,
            json!({"userId":"default","projectId":"missing"})
        )
        .await
        .unwrap_err()
        .code,
        "AGENT_NOT_FOUND"
    );
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/memories",
            "GET",
            Value::Null,
            json!({"userId":"default","projectId":42})
        )
        .await
        .unwrap_err()
        .status,
        400
    );
    let repo = shellpilot_server::agent::Repository::new(services.store.clone());
    assert!(repo
        .project_chats("default", None, "")
        .unwrap()
        .items
        .is_empty());
    let mut deletion = scope;
    deletion["id"] = saved["id"].clone();
    deletion["revision"] = saved["revision"].clone();
    dispatch(
        services.clone(),
        "agent/memories",
        "DELETE",
        deletion.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    assert_eq!(
        dispatch(services, "agent/memories", "GET", Value::Null, deletion)
            .await
            .unwrap()["items"],
        json!([])
    );
}

#[tokio::test]
async fn rename_chat_dispatch_persists_owned_title_without_rewriting_messages() {
    use shellpilot_server::agent::{Payload, Repository};
    let (_dir, services) = services().await;
    let repo = Repository::new(services.store.clone());
    let chat = repo
        .create_general_session("original-model", "default")
        .unwrap();
    repo.append(
        &chat.id,
        "default",
        0,
        "message",
        Payload::UserMessage {
            text: "原消息".into(),
        },
    )
    .unwrap();
    let body = json!({"agentId":"original-model","userId":"default","sessionId":chat.id,"title":"  Docker 排查  "});
    dispatch(
        services.clone(),
        "agent/rename_chat",
        "POST",
        body.clone(),
        Value::Null,
    )
    .await
    .unwrap();
    let list = dispatch(
        services.clone(),
        "agent/project_chats",
        "GET",
        Value::Null,
        json!({"userId":"default"}),
    )
    .await
    .unwrap();
    assert_eq!(list["items"][0]["title"], "Docker 排查");
    assert_eq!(repo.events(&chat.id, "default", 0, 200).unwrap().len(), 1);
    for field in ["agentId", "userId"] {
        let mut foreign = body.clone();
        foreign[field] = json!("wrong");
        assert_eq!(
            dispatch(
                services.clone(),
                "agent/rename_chat",
                "POST",
                foreign,
                Value::Null
            )
            .await
            .unwrap_err()
            .code,
            "AGENT_NOT_FOUND"
        );
    }
    let mut invalid = body;
    invalid["title"] = json!(" ");
    assert_eq!(
        dispatch(
            services.clone(),
            "agent/rename_chat",
            "POST",
            invalid,
            Value::Null
        )
        .await
        .unwrap_err()
        .status,
        400
    );
}

#[tokio::test]
async fn model_catalog_ipc_queries_unsaved_draft_without_persisting_and_reports_errors() {
    use axum::{routing::get, Json, Router};
    let (_dir, services) = services().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/proxy/v1/",listener.local_addr().unwrap());
    let app = Router::new().route("/proxy/v1/models",get(||async {Json(json!({"data":[{"id":"model-one"},{"id":"model-two"}]}))}));
    let server = tokio::spawn(async move {axum::serve(listener,app).await.unwrap();});
    let mut body = json!({"userId":"default","query":{"provider":"openAiCompatible","baseUrl":base,"requireApiKey":false,"apiKey":{"action":"keep"}}});
    let found = dispatch(services.clone(),"agent/model_catalog","POST",body.clone(),Value::Null).await.unwrap();
    assert_eq!(found,json!([{"id":"model-one"},{"id":"model-two"}]));
    let profiles = dispatch(services.clone(),"agent/model_channels","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    assert!(profiles.as_array().unwrap().is_empty());
    body["query"]["baseUrl"] = format!("{}missing/",body["query"]["baseUrl"].as_str().unwrap()).into();
    let error = dispatch(services.clone(),"agent/model_catalog","POST",body.clone(),Value::Null).await.unwrap_err();
    assert_eq!(error.code,"MODEL_CATALOG_FAILED");assert!(error.message.contains("404"));assert!(error.message.contains("手动填写"));
    body["query"]["provider"] = "unsupported".into();
    assert!(dispatch(services,"agent/model_catalog","POST",body,Value::Null).await.is_err());
    server.abort();
}

#[tokio::test]
async fn model_catalog_json_request_logs_trace_and_exposes_id_for_failure() {
    use axum::{routing::get,Json,Router};
    use shellpilot_server::diagnostics::Level;
    let (dir,services)=services().await;let logs=dir.path().join("catalog-logs");services.store.diagnostics.configure(logs.clone(),Level::Debug).unwrap();
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let base=format!("http://{}/v1beta/",listener.local_addr().unwrap());
    let app=Router::new().route("/v1beta/models",get(||async{Json(json!({"models":[{"name":"gemini-3-flash","supportedGenerationMethods":"invalid"}]}))}));
    let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap();});
    let body=json!({"userId":"default","query":{"provider":"googleGemini","baseUrl":base,"requireApiKey":true,"apiKey":{"action":"set","value":"catalog-ipc-test-secret"}}});
    let token=CancellationToken::new();
    let result=dispatch_json_request(services.clone(),"catalog-ipc-trace","agent/model_catalog","POST",body.clone(),Value::Null,&token).await;
    let error=result.unwrap_err();assert_eq!(error.code,"MODEL_CATALOG_FAILED");assert!(error.message.contains("Trace ID：catalog-ipc-trace"));
    let read_rows=|id:&str| {
        let file=logs.join(chrono::Local::now().format("%Y-%m-%d").to_string()).join(format!("{id}.log"));
        let raw=std::fs::read_to_string(file).unwrap();assert!(!raw.contains("catalog-ipc-test-secret"));assert!(!raw.contains("gemini-3-flash"));
        raw.lines().map(|line|serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>()
    };
    let rows=read_rows("catalog-ipc-trace");
    assert!(rows.iter().all(|row|row["traceId"]=="catalog-ipc-trace"));
    assert_eq!(rows.iter().filter(|row|row["event"]=="request.started").count(),1);
    assert_eq!(rows.iter().filter(|row|row["event"]=="request.failed").count(),1);
    assert!(rows.iter().any(|row|row["event"]=="model.catalog.http_request"&&row["fields"]["authentication"]=="x-goog-api-key"));
    assert!(rows.iter().any(|row|row["event"]=="model.catalog.parse_failed"&&row["fields"]["jsonPath"]=="/models/0/supportedGenerationMethods"));
    assert!(!rows.iter().any(|row|row["event"]=="request.completed"));
    token.cancel();
    let cancelled=dispatch_json_request(services,"catalog-ipc-cancel","agent/model_catalog","POST",body,Value::Null,&token).await.unwrap_err();assert_eq!(cancelled.code,"REQUEST_CANCELLED");
    let rows=read_rows("catalog-ipc-cancel");assert!(rows.iter().any(|row|row["event"]=="request.cancelled"&&row["level"]=="warn"));assert!(!rows.iter().any(|row|row["event"]=="request.completed"||row["level"]=="error"));
    server.abort();
}


#[tokio::test]
async fn deepseek_supplier_ipc_roundtrips_channels_choices_and_saved_key_discovery() {
    use axum::{http::HeaderMap,routing::get,Json,Router};
    let (_dir,services)=services().await;
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=format!("http://{}",listener.local_addr().unwrap());
    let app=Router::new().route("/proxy/v1/models",get(|headers:HeaderMap|async move {assert_eq!(headers["authorization"],"Bearer deepseek-ipc-fixture");Json(json!({"data":[{"id":"model-one","name":"First"}]}))}))
        .route("/proxy/models",get(|headers:HeaderMap|async move {assert_eq!(headers["authorization"],"Bearer deepseek-ipc-fixture");assert!(!headers.contains_key("x-api-key"));Json(json!({"data":[{"id":"model-two"}]}))}));
    let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap();});
    save_test_model(&services,format!("{address}/proxy/v1/"));
    let listed=dispatch(services.clone(),"agent/models","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    let original=listed.as_array().unwrap().iter().find(|p|p["id"]=="model").unwrap()["config"].clone();
    for (index,protocol) in ["openAiCompatible","anthropicMessages"].iter().enumerate() {
        let id=format!("deepseek-{index}");let mut config=original.clone();
        config["supplier"]="deepseek".into();config["provider"]=(*protocol).into();config["requireApiKey"]=true.into();
        config["baseUrl"]=format!("{address}/proxy/{}",if index==0{"v1/"}else{"anthropic/v1/"}).into();
        config["completionsPath"]=if index==0{"chat/completions"}else{"messages"}.into();
        let saved=dispatch(services.clone(),"agent/model_channels","POST",json!({"id":id,"userId":"default","revision":0,"displayName":"DeepSeek","modelIds":["model-one","model-two"],"update":{"config":config,"apiKey":{"action":"set","value":"deepseek-ipc-fixture"}}}),Value::Null).await.unwrap();
        assert_eq!(saved["config"]["supplier"],"deepseek");assert_eq!(saved["config"]["provider"],*protocol);assert_eq!(saved["config"]["outputTokenParameter"],"maxTokens");assert!(!saved.to_string().contains("deepseek-ipc-fixture"));
        let models=dispatch(services.clone(),"agent/query_ai_agent_config_list","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
        let members:Vec<_>=models.as_array().unwrap().iter().filter(|m|m["channelId"]==id).collect();assert_eq!(members.len(),2);assert!(members.iter().all(|m|m["supplier"]=="deepseek"&&m["provider"]==*protocol));
        let found=dispatch(services.clone(),"agent/model_catalog","POST",json!({"userId":"default","query":{"supplier":"deepseek","provider":protocol,"baseUrl":config["baseUrl"],"requireApiKey":true,"apiKey":{"action":"keep"},"channelId":id,"revision":saved["revision"]}}),Value::Null).await.unwrap();
        assert_eq!(found[0]["id"],if index==0{"model-one"}else{"model-two"});
    }
    server.abort();
}

#[tokio::test]
async fn glm_supplier_ipc_roundtrips_channels_choices_and_saved_key_discovery() {
    use axum::{http::HeaderMap,routing::get,Json,Router};
    let (_dir,services)=services().await;
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=format!("http://{}",listener.local_addr().unwrap());
    let app=Router::new().route("/proxy/chat/models",get(|headers:HeaderMap|async move {assert_eq!(headers["authorization"],"Bearer glm-ipc-fixture");Json(json!({"data":[{"id":"model-one","name":"First"}]}))}))
        .route("/proxy/messages/models",get(|headers:HeaderMap|async move {assert_eq!(headers["x-api-key"],"glm-ipc-fixture");assert!(!headers.contains_key("authorization"));Json(json!({"data":[{"id":"model-two"}],"has_more":false}))}));
    let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap();});
    save_test_model(&services,format!("{address}/proxy/chat/"));
    let listed=dispatch(services.clone(),"agent/models","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    let original=listed.as_array().unwrap().iter().find(|p|p["id"]=="model").unwrap()["config"].clone();
    for (index,protocol) in ["openAiCompatible","anthropicMessages"].iter().enumerate() {
        let id=format!("glm-{index}");let mut config=original.clone();
        config["supplier"]="glm".into();config["provider"]=(*protocol).into();config["requireApiKey"]=true.into();
        config["baseUrl"]=format!("{address}/proxy/{}/",if index==0{"chat"}else{"messages"}).into();
        config["completionsPath"]=if index==0{"chat/completions"}else{"messages"}.into();
        let saved=dispatch(services.clone(),"agent/model_channels","POST",json!({"id":id,"userId":"default","revision":0,"displayName":"GLM","modelIds":["model-one","model-two"],"update":{"config":config,"apiKey":{"action":"set","value":"glm-ipc-fixture"}}}),Value::Null).await.unwrap();
        assert_eq!(saved["config"]["supplier"],"glm");assert_eq!(saved["config"]["provider"],*protocol);assert_eq!(saved["config"]["outputTokenParameter"],"maxTokens");assert!(!saved.to_string().contains("glm-ipc-fixture"));
        let models=dispatch(services.clone(),"agent/query_ai_agent_config_list","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
        let members:Vec<_>=models.as_array().unwrap().iter().filter(|m|m["channelId"]==id).collect();assert_eq!(members.len(),2);assert!(members.iter().all(|m|m["supplier"]=="glm"&&m["provider"]==*protocol));
        let found=dispatch(services.clone(),"agent/model_catalog","POST",json!({"userId":"default","query":{"supplier":"glm","provider":protocol,"baseUrl":config["baseUrl"],"requireApiKey":true,"apiKey":{"action":"keep"},"channelId":id,"revision":saved["revision"]}}),Value::Null).await.unwrap();
        assert_eq!(found[0]["id"],if index==0{"model-one"}else{"model-two"});
        let mut edited=saved["config"].clone();edited["reasoningEffort"]="high".into();edited["capabilities"]["reasoningEffort"]=true.into();
        let updated=dispatch(services.clone(),"agent/model_channels","POST",json!({"id":id,"userId":"default","revision":saved["revision"],"displayName":"GLM updated","modelIds":["model-one","model-two"],"update":{"config":edited,"apiKey":{"action":"keep"}}}),Value::Null).await.unwrap();
        assert_eq!(updated["models"],saved["models"]);assert_eq!(updated["apiKeyConfigured"],true);assert_eq!(updated["config"]["supplier"],"glm");
    }
    server.abort();
}

#[tokio::test]
async fn qwen_supplier_ipc_preserves_channels_thinking_toggle_and_saved_key_catalog() {
    use axum::{http::HeaderMap,routing::get,Json,Router};
    let (_dir,services)=services().await;let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=format!("http://{}",listener.local_addr().unwrap());
    let app=Router::new().route("/proxy/api/v1/models",get(|headers:HeaderMap|async move {
        assert_eq!(headers["authorization"],"Bearer qwen-ipc-fixture");assert!(!headers.contains_key("x-api-key"));
        Json(json!({"success":true,"output":{"total":1,"page_no":1,"page_size":100,"models":[{"model":"model-one","name":"First"}]}}))
    }));
    let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap();});
    save_test_model(&services,format!("{address}/proxy/compatible-mode/v1/"));
    let listed=dispatch(services.clone(),"agent/models","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
    let original=listed.as_array().unwrap().iter().find(|p|p["id"]=="model").unwrap()["config"].clone();
    for (index,protocol) in ["openAiCompatible","anthropicMessages"].iter().enumerate() {
        let id=format!("qwen-{index}");let mut config=original.clone();config["supplier"]="qwen".into();config["provider"]=(*protocol).into();config["requireApiKey"]=true.into();
        config["baseUrl"]=format!("{address}/proxy/{}",if index==0 {"compatible-mode/v1/"}else{"apps/anthropic/v1/"}).into();
        config["completionsPath"]=if index==0 {"chat/completions"}else{"messages"}.into();config["reasoningEffort"]="enabled".into();config["capabilities"]["reasoningEffort"]=true.into();
        let saved=dispatch(services.clone(),"agent/model_channels","POST",json!({"id":id,"userId":"default","revision":0,"displayName":"Qwen","modelIds":["model-one","model-two"],"update":{"config":config,"apiKey":{"action":"set","value":"qwen-ipc-fixture"}}}),Value::Null).await.unwrap();
        assert_eq!(saved["config"]["supplier"],"qwen");assert_eq!(saved["config"]["provider"],*protocol);assert_eq!(saved["config"]["reasoningEffort"],"enabled");assert_eq!(saved["config"]["outputTokenParameter"],"maxTokens");assert!(!saved.to_string().contains("qwen-ipc-fixture"));
        let models=dispatch(services.clone(),"agent/query_ai_agent_config_list","GET",Value::Null,json!({"userId":"default"})).await.unwrap();
        let members:Vec<_>=models.as_array().unwrap().iter().filter(|m|m["channelId"]==id).collect();assert_eq!(members.len(),2);assert!(members.iter().all(|m|m["supplier"]=="qwen"&&m["provider"]==*protocol));
        let found=dispatch(services.clone(),"agent/model_catalog","POST",json!({"userId":"default","query":{"supplier":"qwen","provider":protocol,"baseUrl":config["baseUrl"],"requireApiKey":true,"apiKey":{"action":"keep"},"channelId":id,"revision":saved["revision"]}}),Value::Null).await.unwrap();assert_eq!(found[0]["id"],"model-one");
        let mut edited=saved["config"].clone();edited["reasoningEffort"]="xhigh".into();
        let updated=dispatch(services.clone(),"agent/model_channels","POST",json!({"id":id,"userId":"default","revision":saved["revision"],"displayName":"Qwen updated","modelIds":["model-one","model-two"],"update":{"config":edited,"apiKey":{"action":"keep"}}}),Value::Null).await.unwrap();
        assert_eq!(updated["models"],saved["models"]);assert_eq!(updated["apiKeyConfigured"],true);assert_eq!(updated["config"]["supplier"],"qwen");
    }
    server.abort();
}
