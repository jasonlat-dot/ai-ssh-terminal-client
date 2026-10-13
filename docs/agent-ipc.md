# Rust Agent 基础对话 IPC（B2/B3）

前端 `src/api/agent.ts` 已接通同进程 Rust Agent 服务：配置列表、创建会话和停止用 invoke；文本流式对话用 `builtin_agent_subscribe` Channel，逐帧调用 `builtin_agent_ack` 确认。事件继续使用既有 `text/done/error` 协议，不走 WebView HTTP 请求。

AI 面板仍由 `App.tsx` 的 Rust 功能开关禁用。模型配置页面属于 B4，本阶段不会执行 SSH 命令、使用附件或自动压缩上下文。

完整接口与边界见兄弟 Rust 工程的 [AGENT_CHAT.md](../../ai-ssh-terminal-server-rust/docs/AGENT_CHAT.md)，进度与 B4 续接入口见 [AGENT_PROGRESS.md](../../ai-ssh-terminal-server-rust/docs/AGENT_PROGRESS.md)。

B3 为用户生成固定 requestId，并将它与短期 streamId 分开。停止携带 requestId，迟到的旧停止不影响下一轮。新增 `agentApi.sessions/history/events` 用于读取原生持久历史；完成请求重读不会调用模型，失败/中断请求不会自动重试。恢复宽限、状态与接口见 [AGENT_TURNS.md](../../ai-ssh-terminal-server-rust/docs/AGENT_TURNS.md)。下一项 B4 接入设置及可见历史面板。

客户端简单验证命令：

```powershell
node --import tsx --test tests/agent-ipc.test.ts tests/ipc-transport.test.ts tests/chat-attachments.test.ts
node node_modules/typescript/bin/tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --offline --lib backend_ipc::tests -- --test-threads=1
```

最新 B3 验证：前端 32/32、原生 IPC 9/9、TypeScript 检查通过。结构化文本/重读 JSON 回复不再二次解码；原生测试仅访问回环模型/SSH 协议夹具，不使用真实 API Key 或用户服务器；完整 GUI 验证仍待后续阶段。
