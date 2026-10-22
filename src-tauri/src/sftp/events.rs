use super::*;

pub(super) async fn subscribe(session: Arc<Session>) {
    let services = &session.services;
    let mut previous = Value::Null;
    loop {
        if session.stop.is_cancelled() {
            break;
        }
        let snapshot = if services.stop.is_cancelled() {
            Err(Error::session_expired())
        } else {
            services.sftp.tasks(&session.id).map_err(from_service)
        };
        match snapshot {
            Ok(tasks) => {
                let mut progress = tasks
                    .into_iter()
                    .map(|task| task.progress)
                    .collect::<Vec<_>>();
                progress.sort_by(|a, b| a.transfer_id.cmp(&b.transfer_id));
                let data = serde_json::to_value(progress).unwrap_or(Value::Null);
                if data != previous {
                    previous = data.clone();
                    session.event("progress", data);
                }
            }
            Err(error) => {
                *session.closed_error.lock().unwrap() = Some(error.clone());
                session.event("session-closed", json!({"code":error.code,"message":error.message}));
                session.stop.cancel();
                break;
            }
        }
        tokio::select! {_=session.stop.cancelled()=>break,_=services.stop.cancelled()=>{},_=tokio::time::sleep(Duration::from_millis(300))=>{}}
    }
}
