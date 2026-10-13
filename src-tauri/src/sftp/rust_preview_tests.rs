use super::*;
#[path = "../../../../ai-ssh-terminal-server-rust/tests/sftp_support/mod.rs"]
#[allow(dead_code)]
mod protocol;
struct LiveBackend {
    fixture: protocol::Fixture,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    url: String,
}
impl LiveBackend {
    async fn new() -> Self {
        let fixture = protocol::Fixture::new().await;
        let (store, _) = fixture.saved(false);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        let task = tokio::spawn(shellpilot_server::serve(
            listener,
            store,
            stopping.cancelled_owned(),
        ));
        Self {
            fixture,
            stop,
            task,
            url,
        }
    }
    async fn open(&self, state: &State, events: Arc<Mutex<Vec<Value>>>) -> String {
        let (store, connection) = self.fixture.saved(false);
        // HTTP backend owns a different store. Obtain a saved connection through its public API.
        let request: Value =
            serde_json::to_value(store.get(&connection.connection_id).unwrap()).unwrap();
        let mut request = request;
        request["password"] = json!("test-password");
        request.as_object_mut().unwrap().remove("createdAt");
        request.as_object_mut().unwrap().remove("updatedAt");
        request.as_object_mut().unwrap().remove("encrypted");
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{}/api/v1/ssh/create_connection", self.url))
            .json(&request)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(response["code"], "SUCCESS_0000");
        let connection = response["data"]["connectionId"]
            .as_str()
            .unwrap()
            .to_string();
        let opened = state
            .open(
                self.url.clone(),
                connection,
                Some("/home".into()),
                None,
                Arc::new(move |event| events.lock().unwrap().push(event)),
            )
            .await
            .unwrap();
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
    let backend = LiveBackend::new().await;
    let state = State::default();
    let events = Arc::new(Mutex::new(vec![]));
    let id = backend.open(&state, events.clone()).await;
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
    let backend = LiveBackend::new().await;
    let state = Arc::new(State::default());
    let id = backend.open(&state, Arc::new(Mutex::new(vec![]))).await;
    let local = tempfile::tempdir().unwrap();
    let source = local.path().join("large");
    std::fs::write(&source, vec![b'x'; 1024 * 1024]).unwrap();
    *backend.fixture.delay.lock().unwrap() = Duration::from_millis(50);
    let task_state = state.clone();
    let task_id = id.clone();
    let upload = tokio::spawn(async move {
        task_state
            .transfer(
                &task_id,
                "UPLOAD",
                source.to_string_lossy().into(),
                "/home".into(),
                "FAIL",
            )
            .await
    });
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
    state.cancel(&id, &transfer).await.unwrap();
    assert!(upload.await.unwrap().is_err());
    assert!(!backend.fixture.root.path().join("home/large").exists());
    *backend.fixture.delay.lock().unwrap() = Duration::ZERO;
    state.mkdir(&id, "/home/usable").await.unwrap();
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .delete(format!("{}/api/v1/sftp/sessions/{}", backend.url, id))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
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
async fn embedded_shutdown_closes_sse_and_interrupts_active_native_transfer() {
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
    let download_state = state.clone();
    let download_id = id.clone();
    let download = tokio::spawn(async move {
        download_state
            .transfer(
                &download_id,
                "DOWNLOAD",
                target,
                "/home/active".into(),
                "FAIL",
            )
            .await
    });
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
    assert!(tokio::time::timeout(Duration::from_secs(5), download)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(!local.path().join("active").exists());
    let _ = state.close(&id).await;
    assert!(state.sessions.lock().unwrap().is_empty());
}
