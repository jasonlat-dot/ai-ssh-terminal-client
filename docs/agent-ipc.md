# Rust Agent 基础对话 IPC（B2/B3）

前端 `src/api/agent.ts` 已接通同进程 Rust Agent 服务：配置列表、创建会话和停止用 invoke；文本流式对话用 `builtin_agent_subscribe` Channel，逐帧调用 `builtin_agent_ack` 确认。事件继续使用既有 `text/done/error` 协议，不走 WebView HTTP 请求。

B4 已启用基础文本 AI 面板与模型配置页面；C1–C4 已接入文字整理和宿主上下文重建。D5 已接通原生 SSH 工具，E1 已接通系统文件选择、附件输入和已发送内容预览，最新状态以 Rust AGENT_PROGRESS.md 为准。操作说明见 [agent-model-settings.md](agent-model-settings.md)。

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

## C4 / C4R：宿主上下文与对话范围

Agent 与终端服务共享同进程 TerminalManager。POST agent/create_session 创建普通范围；POST agent/server_scope 接受 agentId/userId/rootId/terminalSessionId/newTask，身份从原生实际 SSH 握手读取，不接受客户端提供的授权或服务器身份。GET agent/scopes 返回当前用户/模型所属根会话的范围列表。流事件仍为 text/done/error，没有产品 HTTP 后端。

每个普通/服务器任务使用独立 sessionId 和原有日志、检查点与完整 Responses 窗口。server scope 的 identity 包含实际 host/port/username/hostKey，originTerminalId 只是最初终端线索；同身份重连可续用原范围，身份变化不能带入旧历史。每根最多 64 个范围，列表有界。

文字 chat_stream 的 terminalSessionId 是本次环境参考，不是授权：普通范围必须为空；服务器范围可为空进行离线讨论，也可提供匹配身份的当前终端。原始请求回执仍按原 requestId/输入幂等重放。取消只来自本次请求/工作区停止；关闭 SSH 不会取消纯文字生成或整理。实时工具在 D 阶段另行绑定当前 PTY/taskId/有效授权，不能把文本任务当作执行许可。

schema 9 新增 agent_session_scopes，旧 schema 8 日志、检查点、模型名/Key/供应商窗口保持。老会话没有 scope 字段时按原历史保留，不自动转为普通共享上下文。客户端按明确范围显示标题/状态与历史，终端页签变化不自动切换范围；复制终端选区需进入来源任务。完整验证和续接只维护 AGENT_PROGRESS.md。

## C4R 项目工作区

schema 10 增加 agent_projects / agent_project_chats。GET agent/projects 与 GET agent/project_chats 按 userId 返回跨模型项目历史，projectId 为空返回普通/未归属聊天；after 为该分组会话 ID，每页 50 条，nextAfter 继续加载。标题为首轮原请求的有界摘要，不发送模型请求。

POST agent/create_project 接受 userId/name/connectionId，检查保存连接所有权并记录创建时的地址/端口/用户快照。POST agent/project_terminal 接受 userId/projectId/terminalSessionId，从 TerminalManager 检查实际 SSH 身份并绑定/校验项目；不会创建聊天。POST agent/project_chat 额外接受 agentId，核对模型与项目/实际身份后，在同一事务创建独立 server scope 和项目归属。

前端历史点击始终 load 原 sessionId/agentId，再自动连接/原生验证；只有显式“新对话”调用 project_chat。项目聊天无需依赖普通根会话列表，可跨重启恢复。不同项目/模型聊天的日志与整理窗口不合并。旧 scopes 接口保留兼容基础回归；用户已撤销项目侧栏/最左图标导航；项目归组和恢复现在放在原 Agent“历史”弹层。完整验证与里程碑只维护 AGENT_PROGRESS.md。


## 长期记忆

`agent/memories` 的 GET 使用 userId，以及可选的 agentId/sessionId 或 projectId；POST 使用同样范围和 `memory`（id/revision/title/content/kind/scope/enabled）；DELETE 使用同样范围和 id/revision。已有对话仍核对用户/模型/会话归属；没有 sessionId 时，可直接管理全局记忆，或按当前用户持有的 projectId 读取项目的已确认身份，不能同时指定会话和项目。未绑定身份的项目只允许全局记忆。不要求模型配置或创建会话。来源、时间及服务器身份由原生侧生成，不接收客户端提供的目标或来源；无会话来源的 sessionId/agentId 为空，项目来源附加 projectId，兼容既有来源 JSON。

界面入口与使用范围见 [agent-memory.md](agent-memory.md)。版本冲突返回 `AGENT_MEMORY_CHANGED`，无效内容返回 `AGENT_MEMORY_INVALID`。三个操作只管理用户确认的长期记录，不修改任务、检查点或执行批准。


## 历史对话标题

POST `agent/rename_chat` 接受 agentId/userId/sessionId/title，核对原会话用户与模型归属，将去掉首尾空白的 1–80 字符标题保存在 schema 19 的 agent_chat_titles。历史列表优先使用手工标题，未改名时继续使用首条消息摘要；不改写消息、任务、检查点、排序或创建时间，后续新消息也不会覆盖手工标题。删除聊天同时清理标题元数据。仅使用原生派发，不新增 HTTP 入口。
