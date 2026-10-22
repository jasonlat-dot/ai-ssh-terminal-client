use super::*;
#[path = "../../../../ai-ssh-terminal-server-rust/tests/sftp_support/mod.rs"]
#[allow(dead_code)]
mod protocol;
struct LiveBackend {
    fixture: protocol::Fixture,
    services: Arc<shellpilot_server::services::Services>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}
impl LiveBackend {
    async fn new() -> Self { Self::native().await }
    async fn native() -> Self {
        let fixture = protocol::Fixture::new().await;
        let (store, _) = fixture.saved(false);
        let services = shellpilot_server::services::Services::native(
            store, shellpilot_server::files::Settings::default(), uuid::Uuid::new_v4(),
        );
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let stopping_services = services.clone();
        let task = tokio::spawn(async move {
            stopping.cancelled().await;
            stopping_services.shutdown().await;
            Ok(())
        });
        Self { fixture, services, stop, task }
    }
    async fn open(&self, state: &State, events: Arc<Mutex<Vec<Value>>>) -> String {
        let (store, connection) = self.fixture.saved(false);
        let mut request = serde_json::to_value(store.get(&connection.connection_id).unwrap()).unwrap();
        request["password"] = json!("test-password");
        request.as_object_mut().unwrap().remove("createdAt");
        request.as_object_mut().unwrap().remove("updatedAt");
        request.as_object_mut().unwrap().remove("encrypted");
        let connection = self.services.store.save(serde_json::from_value(request).unwrap(), false).unwrap();
        let opened = state.open_local(
            self.services.clone(), shellpilot_server::sftp::model::OpenRequest {
                connection_id: connection.connection_id, root_path: Some("/home".into()), ..Default::default()
            },
            Arc::new(move |event| events.lock().unwrap().push(event)),
        ).await.unwrap();
        opened["sftpSessionId"].as_str().unwrap().into()
    }
    async fn shutdown(self) {
        self.stop.cancel();
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
#[tokio::test]
async fn native_bridge_round_trips_real_rust_sftp_nested_empty_and_unicode_files() {
    round_trip(LiveBackend::new().await).await;
}
#[tokio::test]
async fn native_bridge_preserves_explicit_root_access_identity_and_secret() {
    let backend = LiveBackend::native().await;
    *backend.fixture.root_access.lock().unwrap() = protocol::RootAccess::Password;
    let state = State::default();
    let login_id = backend.open(&state, Arc::new(Mutex::new(vec![]))).await;
    let login = backend.services.sftp.session_view(&login_id).unwrap();
    let root = state.open_local(backend.services.clone(), shellpilot_server::sftp::model::OpenRequest {
        connection_id: login.connection_id,
        access_mode: shellpilot_server::sftp::model::AccessMode::SudoRoot,
        sudo_password: Some("sudo-test-password".into()),
        ..Default::default()
    }, Arc::new(|_| {})).await.unwrap();
    let id = root["sftpSessionId"].as_str().unwrap();
    assert_eq!(root["loginUsername"], "tester");
    assert_eq!(root["accessUsername"], "root");
    assert_eq!(root["accessMode"], "sudoRoot");
    assert_eq!(root["rootPath"], "/root");
    assert!(!root.to_string().contains("sudo-test-password"));
    state.create_file(id, "/root/private").await.unwrap();
    let entries = state.entries(id, "/root").await.unwrap();
    assert_eq!(entries[0]["name"], "private");
    assert_eq!(backend.services.sftp.session_view(&login_id).unwrap().access_username, "tester");
    state.close(id).await.unwrap();
    state.close(&login_id).await.unwrap();
    backend.shutdown().await;
}

#[tokio::test]
async fn native_bridge_uses_bound_terminal_root_auth_and_current_directory_without_second_password() {
    use shellpilot_server::terminal::{completion::ShellIntegration, OpenRequest};
    let fixture = protocol::Fixture::new().await;
    fixture.file("/root/current/private.txt", b"native-root-test");
    let (store, connection) = fixture.saved(false);
    let services = shellpilot_server::services::Services::native(store, Default::default(), uuid::Uuid::new_v4());
    let terminal = services.terminals.connect_with_completion(OpenRequest {
        connection_id: connection.connection_id.clone(), request_id: uuid::Uuid::new_v4().to_string(), cols: None, rows: None,
    }, Some(ShellIntegration { nonce: "f".repeat(32), script: "true".into() })).await.unwrap();
    services.terminals.write(&terminal.session_id, "TEST_ROOT".into()).await.unwrap();
    let _ = services.terminals.read(&terminal.session_id).await;
    let state = State::default();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = events.clone();
    let opened = state.open_terminal_local(services.clone(), shellpilot_server::sftp::model::OpenRequest {
        connection_id: connection.connection_id, root_path: Some("/".into()), ..Default::default()
    }, Some(&terminal.session_id), Arc::new(move |event| received.lock().unwrap().push(event))).await.unwrap();
    let id = opened["sftpSessionId"].as_str().unwrap();
    assert_eq!(opened["accessUsername"], "root");
    let entries = state.entries(id, "/root/current").await.unwrap();
    assert_eq!(entries[0]["name"], "private.txt");
    assert_eq!(fixture.stats.password_prompts.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(fixture.stats.connections.load(std::sync::atomic::Ordering::SeqCst), 1);
    state.rename_entry(id, "/root/current/private.txt", "/root/current/renamed.txt").await.unwrap();
    state.mkdir(id, "/root/current/subdir").await.unwrap();
    state.rename_entry(id, "/root/current/renamed.txt", "/root/current/subdir/private.txt").await.unwrap();
    assert_eq!(state.entries(id, "/root/current/subdir").await.unwrap()[0]["name"], "private.txt");
    state.delete_tree(id, "/root/current/subdir").await.unwrap();
    assert!(state.entries(id, "/root/current").await.unwrap().as_array().unwrap().is_empty());
    services.terminals.write(&terminal.session_id, "TEST_LOGIN".into()).await.unwrap();
    let _ = services.terminals.read(&terminal.session_id).await;
    protocol::eventually(|| events.lock().unwrap().iter().any(|event| event["type"] == "session-closed")).await;
    let closed = events.lock().unwrap().iter().find(|event| event["type"] == "session-closed").unwrap().clone();
    assert_eq!(closed["data"]["code"], "SFTP_IDENTITY_CHANGED");
    assert_eq!(state.entries(id, "/root/current").await.unwrap_err().code, "SFTP_IDENTITY_CHANGED");
    assert_eq!(state.delete_tree(id, "/root/current").await.unwrap_err().code, "SFTP_IDENTITY_CHANGED");
    assert_eq!(state.rename_entry(id, "/root/current", "/root/changed").await.unwrap_err().code, "SFTP_IDENTITY_CHANGED");
    state.close(id).await.unwrap();
    assert!(services.terminals.connected(&terminal.session_id).connected);
    services.shutdown().await;
}
#[tokio::test]
async fn native_direct_services_round_trip_without_an_http_listener() {
    round_trip(LiveBackend::native().await).await;
}

#[tokio::test]
async fn native_bridge_closing_two_tabs_releases_only_their_own_files_without_missing_errors() {
    use shellpilot_server::terminal::OpenRequest;
    let fixture = protocol::Fixture::new().await;
    let (store, connection) = fixture.saved(false);
    let services = shellpilot_server::services::Services::native(
        store, shellpilot_server::files::Settings::default(), uuid::Uuid::new_v4(),
    );
    let state = State::default();
    let mut tabs = Vec::new();
    for _ in 0..2 {
        let terminal = services.terminals.connect(OpenRequest {
            connection_id: connection.connection_id.clone(), request_id: uuid::Uuid::new_v4().to_string(), cols: None, rows: None,
        }).await.unwrap();
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received = events.clone();
        let opened = state.open_terminal_local(services.clone(), shellpilot_server::sftp::model::OpenRequest {
            connection_id: connection.connection_id.clone(), root_path: Some("/home".into()), ..Default::default()
        }, Some(&terminal.session_id), Arc::new(move |event| received.lock().unwrap().push(event))).await.unwrap();
        let id = opened["sftpSessionId"].as_str().unwrap().to_owned();
        let cached = state.get(&id).unwrap();
        tabs.push((terminal.session_id, id, events, cached));
    }
    assert_eq!(fixture.stats.connections.load(std::sync::atomic::Ordering::SeqCst), 1);
    services.terminals.close(&tabs[0].0);
    assert_eq!(state.entries(&tabs[0].1, "/home").await.unwrap_err().code, "SFTP_TERMINAL_CLOSED");
    assert!(services.terminals.connected(&tabs[1].0).connected);
    state.entries(&tabs[1].1, "/home").await.unwrap();
    services.terminals.close(&tabs[1].0);
    for (terminal, files, events, cached) in &tabs {
        assert!(!services.terminals.connected(terminal).connected);
        protocol::eventually(|| events.lock().unwrap().iter().any(|event| event["type"] == "session-closed")).await;
        let closed = events.lock().unwrap().iter().find(|event| event["type"] == "session-closed").unwrap().clone();
        assert_eq!(closed["data"]["code"], "SFTP_TERMINAL_CLOSED");
        assert_eq!(state.entries(files, "/home").await.unwrap_err().code, "SFTP_TERMINAL_CLOSED");
        for _ in 0..4 {
            assert_eq!(cached.json(Method::GET, &format!("sessions/{files}/transfers"), None).await.unwrap_err().code, "SFTP_TERMINAL_CLOSED", "cancelled in-flight requests preserve the normal-close reason");
        }
        state.close(files).await.unwrap();
        state.close(files).await.unwrap();
    }
    services.shutdown().await;
}
async fn wait_for_jobs(session: &Arc<Session>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if session.jobs.lock().unwrap().values().all(|job| !job.running.load(std::sync::atomic::Ordering::SeqCst)) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("background transfers must settle");
}
async fn round_trip(backend: LiveBackend) {
    let state = State::default();
    let events = Arc::new(Mutex::new(vec![]));
    let id = backend.open(&state, events.clone()).await;
    let session = state.get(&id).unwrap();
    let local = tempfile::tempdir().unwrap();
    let tree = local.path().join("tree");
    std::fs::create_dir_all(tree.join("empty")).unwrap();
    std::fs::create_dir_all(tree.join("子目录")).unwrap();
    std::fs::write(tree.join("子目录/data"), b"actual native HTTP SFTP bytes").unwrap();
    std::fs::write(tree.join("zero"), b"").unwrap();
    state
        .transfer(
            &id,
            "UPLOAD",
            tree.to_string_lossy().into(),
            "/home".into(),
            "FAIL",
        )
        .await
        .unwrap();
    wait_for_jobs(&session).await;
    assert_eq!(
        backend.fixture.read("/home/tree/子目录/data"),
        b"actual native HTTP SFTP bytes"
    );
    let downloaded = local.path().join("download");
    std::fs::create_dir(&downloaded).unwrap();
    state
        .transfer(
            &id,
            "DOWNLOAD",
            downloaded.to_string_lossy().into(),
            "/home/tree".into(),
            "FAIL",
        )
        .await
        .unwrap();
    wait_for_jobs(&session).await;
    assert_eq!(
        std::fs::read(downloaded.join("tree/子目录/data")).unwrap(),
        b"actual native HTTP SFTP bytes"
    );
    assert!(downloaded.join("tree/empty").is_dir());
    assert_eq!(
        std::fs::metadata(downloaded.join("tree/zero"))
            .unwrap()
            .len(),
        0
    );
    let tasks = state.tasks(&id).await.unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 2);
    assert!(tasks
        .as_array()
        .unwrap()
        .iter()
        .all(|task| task["progress"]["status"] == "COMPLETED"));
    protocol::eventually(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "progress")
    })
    .await;
    assert!(state
        .transfer(
            &id,
            "DOWNLOAD",
            downloaded.to_string_lossy().into(),
            "/home/tree".into(),
            "FAIL"
        )
        .await
        .is_err());
    assert_eq!(
        std::fs::read(downloaded.join("tree/子目录/data")).unwrap(),
        b"actual native HTTP SFTP bytes"
    );
    state.close(&id).await.unwrap();
    backend.shutdown().await;
}
#[tokio::test]
async fn native_bridge_survives_expired_sessions_and_cancels_real_upload() {
    cancel_and_expire(LiveBackend::new().await).await;
}
#[tokio::test]
async fn native_direct_services_cancel_and_expire_without_http() {
    cancel_and_expire(LiveBackend::native().await).await;
}
async fn cancel_and_expire(backend: LiveBackend) {
    let state = Arc::new(State::default());
    let id = backend.open(&state, Arc::new(Mutex::new(vec![]))).await;
    let local = tempfile::tempdir().unwrap();
    let source = local.path().join("large");
    std::fs::write(&source, vec![b'x'; 1024 * 1024]).unwrap();
    *backend.fixture.delay.lock().unwrap() = Duration::from_millis(50);
    let session = state.get(&id).unwrap();
    tokio::time::timeout(Duration::from_millis(800), async {
        state
            .transfer(
                &id,
                "UPLOAD",
                source.to_string_lossy().into(),
                "/home".into(),
                "FAIL",
            )
            .await
    }).await.expect("task creation must return before the slow upload finishes").unwrap();
    let transfer = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let tasks = state.tasks(&id).await.unwrap();
            if let Some(task) = tasks.as_array().unwrap().first() {
                break task["transferId"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(state.tasks(&id).await.unwrap()[0]["progress"]["status"], "COMPLETED");
    assert!(session.jobs.lock().unwrap()[&transfer].running.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(state.retry(&id, &transfer).await.unwrap_err().message, "任务仍在执行");
    state.cancel(&id, &transfer).await.unwrap();
    wait_for_jobs(&session).await;
    assert!(!backend.fixture.root.path().join("home/large").exists());
    *backend.fixture.delay.lock().unwrap() = Duration::ZERO;
    state.mkdir(&id, "/home/usable").await.unwrap();
    backend.services.sftp.close(&id).unwrap();
    // Wait for session-closed to reach the native bridge before asserting expired-state behavior.
    protocol::eventually(|| state.get(&id).is_err()).await;
    assert_eq!(
        state
            .create_file(&id, "/home/new")
            .await
            .unwrap_err()
            .status,
        404
    );
    state.close(&id).await.unwrap();
    backend.shutdown().await;
}

#[tokio::test]
async fn workspace_shutdown_interrupts_active_native_transfer() {
    let backend = LiveBackend::new().await;
    backend
        .fixture
        .file("/home/active", &vec![b'x'; 1024 * 1024]);
    *backend.fixture.delay.lock().unwrap() = Duration::from_millis(60);
    let state = Arc::new(State::default());
    let events = Arc::new(Mutex::new(Vec::new()));
    let id = backend.open(&state, events.clone()).await;
    let local = tempfile::tempdir().unwrap();
    let target = local.path().to_string_lossy().to_string();
    let session = state.get(&id).unwrap();
    tokio::time::timeout(Duration::from_millis(800), async {
        state
            .transfer(
                &id,
                "DOWNLOAD",
                target,
                "/home/active".into(),
                "FAIL",
            )
            .await
    }).await.expect("download creation must not wait for file bytes").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let tasks = state.tasks(&id).await.unwrap();
            if tasks
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["progress"]["status"] == "RUNNING")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    backend.shutdown().await;
    wait_for_jobs(&session).await;
    assert!(!local.path().join("active").exists());
    let _ = state.close(&id).await;
    assert!(state.sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn queued_transfer_keeps_failures_visible_and_retries_in_background() {
    let backend = LiveBackend::native().await;
    backend.fixture.file("/home/collision", b"keep original");
    let state = State::default();
    let events = Arc::new(Mutex::new(Vec::new()));
    let id = backend.open(&state, events.clone()).await;
    let session = state.get(&id).unwrap();
    let local = tempfile::tempdir().unwrap();
    let source = local.path().join("collision");
    std::fs::write(&source, b"retry these bytes").unwrap();

    state.transfer(&id, "UPLOAD", source.to_string_lossy().into(), "/home".into(), "FAIL").await.unwrap();
    wait_for_jobs(&session).await;
    let task = state.tasks(&id).await.unwrap()[0].clone();
    let transfer = task["transferId"].as_str().unwrap();
    assert_eq!(task["progress"]["status"], "FAILED");
    assert_eq!(task["items"][0]["status"], "FAILED");
    assert_eq!(backend.fixture.read("/home/collision"), b"keep original");
    assert!(events.lock().unwrap().iter().any(|event| event["type"] == "error" && event["data"]["transferId"] == transfer));

    std::fs::remove_file(backend.fixture.root.path().join("home/collision")).unwrap();
    state.retry(&id, transfer).await.unwrap();
    wait_for_jobs(&session).await;
    assert_eq!(state.tasks(&id).await.unwrap()[0]["progress"]["status"], "COMPLETED");
    assert_eq!(backend.fixture.read("/home/collision"), b"retry these bytes");
    state.close(&id).await.unwrap();
    backend.shutdown().await;
}
