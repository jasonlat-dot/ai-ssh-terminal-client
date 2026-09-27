use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Backend {
    task: Mutex<Value>,
    manifest: Vec<Value>,
    content: Vec<u8>,
    uploads: Mutex<Vec<Vec<u8>>>,
    get_count: AtomicUsize,
    fail_confirm_once: AtomicBool,
    busy_once: AtomicBool,
}
struct Fixture {
    state: State,
    backend: Arc<Backend>,
    root: PathBuf,
    listener_stop: Arc<AtomicBool>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.listener_stop.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn reply(stream: &mut TcpStream, status: u16, body: &[u8], kind: &str) {
    let headers = format!("HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(body);
}
fn success(stream: &mut TcpStream, value: Value) {
    reply(
        stream,
        200,
        json!({"code":"SUCCESS_0000","data":value})
            .to_string()
            .as_bytes(),
        "application/json",
    );
}
fn handle(mut stream: TcpStream, backend: Arc<Backend>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = vec![];
    let mut byte = [0u8];
    while !bytes.ends_with(b"\r\n\r\n") {
        if stream.read_exact(&mut byte).is_err() {
            return;
        }
        bytes.push(byte[0]);
    }
    let headers = String::from_utf8(bytes).unwrap();
    let mut words = headers.split_whitespace();
    let method = words.next().unwrap();
    let route = words.next().unwrap().trim_start_matches("/api/v1/sftp/");
    let size = headers
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .map(|s| s.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; size];
    stream.read_exact(&mut body).unwrap();
    if route == "sessions" {
        success(
            &mut stream,
            json!({"sftpSessionId":"session","connectionId":"connection","rootPath":"/","createdAt":"2026-09-27T00:00:00Z"}),
        );
        return;
    }
    if route.ends_with("/events") {
        reply(&mut stream, 200, b": heartbeat\n\n", "text/event-stream");
        return;
    }
    if method == "DELETE" {
        success(&mut stream, Value::Null);
        return;
    }
    if route == "transfers" {
        let input: Value = serde_json::from_slice(&body).unwrap();
        let upload = input["direction"] == "UPLOAD";
        let manifest = if upload {
            input["items"].as_array().unwrap().clone()
        } else {
            backend.manifest.clone()
        };
        let items: Vec<Value> = manifest
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let mut item = item.clone();
                item["itemId"] = json!(i.to_string());
                item["status"] = json!(if item["kind"] == "DIRECTORY" {
                    if upload {
                        "COMPLETED"
                    } else {
                        "SENT"
                    }
                } else {
                    "PENDING"
                });
                item
            })
            .collect();
        let task = json!({"transferId":"task","sftpSessionId":"session","direction":input["direction"],"remotePath":input["remotePath"],"progress":{"status":"AWAITING_CONTENT"},"items":items});
        *backend.task.lock().unwrap() = task.clone();
        success(&mut stream, task);
        return;
    }
    if route == "sessions/session/transfers" {
        success(&mut stream, json!([backend.task.lock().unwrap().clone()]));
        return;
    }
    if route == "transfers/task" {
        success(&mut stream, backend.task.lock().unwrap().clone());
        return;
    }
    if route.ends_with("/cancel") {
        let mut task = backend.task.lock().unwrap();
        task["progress"]["status"] = json!("CANCELLED");
        for item in task["items"].as_array_mut().unwrap() {
            item["status"] = json!("CANCELLED");
        }
        success(&mut stream, Value::Null);
        return;
    }
    let id: usize = route.split('/').nth(3).unwrap().parse().unwrap();
    if route.ends_with("/confirm") {
        if backend.fail_confirm_once.swap(false, Ordering::SeqCst) {
            reply(
                &mut stream,
                502,
                br#"{"code":"SFTP_IO_ERROR","info":"confirmation response lost"}"#,
                "application/json",
            );
            return;
        }
        let saved = serde_json::from_slice::<Value>(&body).unwrap()["saved"] == true;
        backend.task.lock().unwrap()["items"][id]["status"] =
            json!(if saved { "COMPLETED" } else { "FAILED" });
        success(&mut stream, Value::Null);
        return;
    }
    if backend.busy_once.swap(false, Ordering::SeqCst) {
        reply(
            &mut stream,
            429,
            br#"{"code":"SFTP_BUSY","info":"busy"}"#,
            "application/json",
        );
        return;
    }
    if method == "PUT" {
        backend.uploads.lock().unwrap().push(body);
        backend.task.lock().unwrap()["items"][id]["status"] = json!("COMPLETED");
        success(&mut stream, Value::Null);
    } else {
        backend.get_count.fetch_add(1, Ordering::SeqCst);
        backend.task.lock().unwrap()["items"][id]["status"] = json!("SENT");
        reply(
            &mut stream,
            200,
            &backend.content,
            "application/octet-stream",
        );
    }
}
async fn fixture(manifest: Vec<Value>, content: &[u8]) -> Fixture {
    let backend = Arc::new(Backend {
        task: Mutex::new(Value::Null),
        manifest,
        content: content.to_vec(),
        uploads: Mutex::new(vec![]),
        get_count: AtomicUsize::new(0),
        fail_confirm_once: AtomicBool::new(false),
        busy_once: AtomicBool::new(false),
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let listener_stop = Arc::new(AtomicBool::new(false));
    let stop = listener_stop.clone();
    let server = backend.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            if let Ok((stream, _)) = listener.accept() {
                let server = server.clone();
                std::thread::spawn(move || handle(stream, server));
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    });
    let state = State::default();
    state
        .open(
            format!("http://{address}"),
            "connection".into(),
            None,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let root = std::env::temp_dir().join(format!(
        "sftp-transfer-test-{}-{}",
        std::process::id(),
        address.port()
    ));
    std::fs::create_dir_all(&root).unwrap();
    Fixture {
        state,
        backend,
        root,
        listener_stop,
    }
}
fn manifest(path: &str, kind: &str, size: usize) -> Value {
    json!({"relativePath":path,"kind":kind,"size":size})
}

#[tokio::test]
async fn downloads_zero_byte_files_and_empty_directories_and_confirms_both() {
    let f = fixture(
        vec![
            manifest("demo/empty", "DIRECTORY", 0),
            manifest("demo/zero", "FILE", 0),
        ],
        b"",
    )
    .await;
    f.state
        .transfer(
            "session",
            "DOWNLOAD",
            f.root.to_str().unwrap().into(),
            "/demo".into(),
            "FAIL",
        )
        .await
        .unwrap();
    assert!(f.root.join("demo/empty").is_dir());
    assert_eq!(std::fs::read(f.root.join("demo/zero")).unwrap(), b"");
    assert_eq!(f.backend.get_count.load(Ordering::SeqCst), 1);
    assert!(f.backend.task.lock().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| i["status"] == "COMPLETED"));
    f.state.close("session").await.unwrap();
}
#[tokio::test]
async fn truncated_200_is_not_a_successful_download_and_removes_temp_file() {
    let f = fixture(vec![manifest("data", "FILE", 10)], b"short").await;
    assert!(f
        .state
        .transfer(
            "session",
            "DOWNLOAD",
            f.root.to_str().unwrap().into(),
            "/data".into(),
            "FAIL"
        )
        .await
        .is_err());
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 0);
    assert_eq!(
        f.backend.task.lock().unwrap()["items"][0]["status"],
        "FAILED"
    );
    f.state.close("session").await.unwrap();
}
#[tokio::test]
async fn confirmation_retry_does_not_download_or_overwrite_saved_file() {
    let f = fixture(vec![manifest("data", "FILE", 3)], b"abc").await;
    f.backend.fail_confirm_once.store(true, Ordering::SeqCst);
    assert!(f
        .state
        .transfer(
            "session",
            "DOWNLOAD",
            f.root.to_str().unwrap().into(),
            "/data".into(),
            "FAIL"
        )
        .await
        .is_err());
    assert_eq!(std::fs::read(f.root.join("data")).unwrap(), b"abc");
    f.state.retry("session", "task").await.unwrap();
    assert_eq!(f.backend.get_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.backend.task.lock().unwrap()["items"][0]["status"],
        "COMPLETED"
    );
    f.state.close("session").await.unwrap();
}
#[tokio::test]
async fn refuses_existing_destination_before_fetching_content() {
    let f = fixture(vec![manifest("data", "FILE", 3)], b"abc").await;
    std::fs::write(f.root.join("data"), b"keep").unwrap();
    assert!(f
        .state
        .transfer(
            "session",
            "DOWNLOAD",
            f.root.to_str().unwrap().into(),
            "/data".into(),
            "FAIL"
        )
        .await
        .is_err());
    assert_eq!(std::fs::read(f.root.join("data")).unwrap(), b"keep");
    assert_eq!(f.backend.get_count.load(Ordering::SeqCst), 0);
    f.state.close("session").await.unwrap();
}
#[tokio::test]
async fn uploads_nested_and_empty_items_and_retries_busy_response() {
    let f = fixture(vec![], b"").await;
    let source = f.root.join("demo");
    std::fs::create_dir_all(source.join("empty")).unwrap();
    std::fs::write(source.join("config"), b"abc").unwrap();
    std::fs::write(source.join("zero"), b"").unwrap();
    f.backend.busy_once.store(true, Ordering::SeqCst);
    f.state
        .transfer(
            "session",
            "UPLOAD",
            source.to_str().unwrap().into(),
            "/".into(),
            "FAIL",
        )
        .await
        .unwrap();
    let bodies = f.backend.uploads.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2);
    assert!(bodies.contains(&b"abc".to_vec()));
    assert!(bodies.contains(&vec![]));
    assert!(f.backend.task.lock().unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["relativePath"] == "demo/empty"));
    f.state.close("session").await.unwrap();
}
#[test]
fn command_futures_are_send() {
    fn send(_: impl Send) {}
    let state = State::default();
    send(state.transfer("s", "UPLOAD", "a".into(), "/".into(), "FAIL"));
    send(state.retry("s", "t"));
    send(state.cancel("s", "t"));
    send(state.close("s"));
}
