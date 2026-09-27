use super::*;

// Assemble complete UTF-8 lines before decoding; HTTP chunks may split a Chinese character.
#[derive(Default)]
struct Parser {
    pending: Vec<u8>,
    event: String,
    data: Vec<String>,
}
impl Parser {
    fn feed(&mut self, bytes: &[u8]) -> Result<Vec<(String, String)>> {
        self.pending.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| Error::local("SSE 编码无效"))?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    frames.push((std::mem::take(&mut self.event), self.data.join("\n")));
                }
                self.data.clear();
                self.event.clear();
            } else if let Some(event) = line.strip_prefix("event:") {
                self.event = event.trim_start().into();
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).into());
            }
        }
        if self.pending.len() > 16 * 1024 * 1024 {
            return Err(Error::local("SSE 事件过大"));
        }
        Ok(frames)
    }
}
pub(super) async fn subscribe(session: Arc<Session>) {
    let mut delay = 1;
    loop {
        let result = tokio::select! {
            _ = session.stop.cancelled() => break,
            result = consume(&session) => result,
        };
        if session.stop.is_cancelled() {
            break;
        }
        if result
            .as_ref()
            .err()
            .is_some_and(|error| [401, 403, 404].contains(&error.status))
        {
            session.event(
                "session-closed",
                json!({"message":result.unwrap_err().message}),
            );
            session.stop.cancel();
            break;
        }
        session.event("connection", json!("进度连接中断，正在重连；文件传输继续"));
        tokio::select! { _ = session.stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
        delay = (delay * 2).min(15);
    }
}
async fn consume(session: &Session) -> Result<()> {
    let response = session
        .client
        .get(session.url(&format!("sessions/{}/events", session.id)))
        .header("Accept", "text/event-stream")
        .send()
        .await?;
    if !response.status().is_success() {
        response_json(response).await?;
        return Ok(());
    }
    session.event("connection", json!("进度已连接"));
    let mut stream = response.bytes_stream();
    let mut parser = Parser::default();
    while let Some(bytes) = stream.next().await {
        for (kind, data) in parser.feed(&bytes?)? {
            if kind == "session-closed" {
                session.event(&kind, serde_json::from_str(&data)?);
                session.stop.cancel();
                return Ok(());
            }
            if kind == "progress" {
                session.event(&kind, serde_json::from_str(&data)?);
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_chunked_utf8_crlf_heartbeats_and_multiple_events() {
        let text = ":heartbeat\r\n\r\nevent: progress\r\ndata: [\"文件\"]\r\n\r\nevent: session-closed\ndata: {}\n\n";
        let mut parser = Parser::default();
        let mut frames = vec![];
        for byte in text.bytes() {
            frames.extend(parser.feed(&[byte]).unwrap());
        }
        assert_eq!(
            frames,
            vec![
                ("progress".into(), "[\"文件\"]".into()),
                ("session-closed".into(), "{}".into())
            ]
        );
    }
}
