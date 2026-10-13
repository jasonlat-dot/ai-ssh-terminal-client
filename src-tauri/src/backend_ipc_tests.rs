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
        501
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
