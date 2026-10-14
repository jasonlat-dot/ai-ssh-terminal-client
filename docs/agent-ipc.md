# Rust Agent 基础对话 IPC（B2/B3）

前端 `src/api/agent.ts` 已接通同进程 Rust Agent 服务：配置列表、创建会话和停止用 invoke；文本流式对话用 `builtin_agent_subscribe` Channel，逐帧调用 `builtin_agent_ack` 确认。事件继续使用既有 `text/done/error` 协议，不走 WebView HTTP 请求。

B4 已启用基础文本 AI 面板与模型配置页面，不会执行 SSH 命令、使用聊天附件或自动压缩上下文。操作说明见 [agent-model-settings.md](agent-model-settings.md)。

完整接口与边界见兄弟 Rust 工程的 [AGENT_CHAT.md](../../ai-ssh-terminal-server-rust/docs/AGENT_CHAT.md)，进度与 B4 续接入口见 [AGENT_PROGRESS.md](../../ai-ssh-terminal-server-rust/docs/AGENT_PROGRESS.md)。

B3 为用户生成固定 requestId，并将它与短期 streamId 分开。停止携带 requestId，迟到的旧停止不影响下一轮。`agentApi.sessions/history/events` 读取原生持久历史，B4 可见历史面板已采用此数据；完成请求重读不会调用模型，失败/中断请求不会自动重试。恢复宽限、状态与接口见 [AGENT_TURNS.md](../../ai-ssh-terminal-server-rust/docs/AGENT_TURNS.md)。

B4 新增 `GET/POST/DELETE agent/models`，GET 使用 userId 参数，写操作携带 `{id,userId,revision}`，POST 额外携带 `update: {config,apiKey}`。数据库与 DPAPI 操作在阻塞线程完成；配置响应不包含密钥，运行配置不经过 IPC。配置错误返回 MODEL_CONFIG_INVALID / MODEL_CONFIG_CHANGED / MODEL_CONFIG_NOT_FOUND 等明确错误码。对话仍通过 Channel，不新增产品 HTTP 监听。

客户端简单验证命令：

```powershell
node --import tsx --test tests/agent-history.test.ts tests/agent-ipc.test.ts tests/ipc-transport.test.ts tests/chat-attachments.test.ts
node node_modules/typescript/bin/tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --offline --lib backend_ipc::tests -- --test-threads=1
```

最新 B4 验证：前端 37/37、原生 IPC 11/11、TypeScript 和前端生产构建通过。原生测试仅访问回环模型/SSH 协议夹具，不使用真实 API Key 或用户服务器；完整 GUI 验证仍待后续阶段。

## B5 验证（2026-10-14）

已补齐回环模型协议 → 原生 dispatch/agent_stream/ACK → SQLite 的停止、续聊、中断与关闭重开测试；前端补取消隔离、迟到回调、恢复请求和草稿保护回归。历史恢复生成的停止操作现有明确等待状态、防重入和 5 秒确认超时，随后以 SQLite 历史为准。模型设置及名称/密钥身份关系保持不变。

验证：原生 IPC 15 项、前端相关 48 项、TypeScript/Vite 构建通过；Rust 库相关 55 项与 Clippy -D warnings 通过。产品不新增监听端口，测试 HTTP 端口仅模拟模型供应商。

本轮 Tabbit 路由不可用；用户要求不处理该项。组件回归不是完整 WebView 截图验收，真实明暗主题/窄面板检查留待 E6。完整验证证据见兄弟 Rust 库 docs/AGENT_PROGRESS.md 的 B5 完成记录。本轮未提交、推送或打包。
