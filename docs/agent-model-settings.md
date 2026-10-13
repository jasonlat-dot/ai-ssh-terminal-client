# B4：模型设置与基础文本对话

## 从哪里配置

临时运行桌面客户端后，点击左侧齿轮 → **模型设置**。也可以展开终端工具栏的机器人按钮，在 AI 面板中点击 **模型设置**。

1. 点击“新建配置”，填写配置名称和供应商提供的模型 ID。
2. 填写 API 基础地址和相对接口路径。例如基础地址 `https://model.example.com/v1/`，相对路径 `chat/completions`，最终请求地址为 `https://model.example.com/v1/chat/completions`。不要把密钥填进地址，也不要重复 `/v1`。
3. 需要认证时选择“设置 / 替换密钥”，填写 API Key。无认证的本地模型服务可以取消“此服务需要 API Key”，并选择“清除密钥”。
4. 上下文窗口、最大输出按供应商说明填写。8192 / 1024 是初始值，程序不会自动探测模型窗口。输出与安全预留之和必须小于窗口。
5. 点击“保存模型”，返回终端，展开 AI 面板并选择该配置，发送一条文本消息。

“已配置”表示字段和密钥满足配置要求；首次发送才验证网络、认证和模型协议。模型不支持 `max_completion_tokens` 时，可在高级参数中切换到 `max_tokens`。Temperature 和 Reasoning effort 默认不发送，仅在供应商明确支持时设置。响应大小和超时也在高级参数中修改。

配置保存后立即用于后续请求，不需要重启或修改 `.env`。回复期间不能修改模型或切换配置；切换配置会进入新的空会话，原来的会话可以从对应模型的历史中打开。

## 密钥与本地数据

API Key 使用 Windows DPAPI 加密，保存在当前工作区 SQLite 模型配置表中；与 Windows 用户、应用用户和配置 ID 绑定。读取配置只返回“是否已保存”，不返回密钥。设置页面中的新密钥输入仅在本次编辑期间存在，保存成功、切换配置或关闭设置后清除。

编辑时默认“保留现有密钥”。更换 API 基础地址时必须明确替换或清除密钥，防止将旧密钥发给新的服务。不要将加密数据库视为可以跨 Windows 用户直接恢复的明文配置。

多窗口同时编辑会检查配置版本。提示版本冲突时点击“重新加载配置”，再重新编辑。删除配置需要在页面中确认；历史仍保留在数据库中，重新建立相同配置 ID 后可以读取。旧版 Java 聊天记录自动导入属于 E4，本阶段不做导入。

## 对话、停止与恢复

- 当前支持文字提问、纯文本粘贴、流式回复、停止生成和历史会话。聊天附件、工具执行和审批、自动压缩尚未接入，面板会说明这些边界。
- 回复期间切换终端页签不会改变该会话的目标。继续旧会话会使用原来的目标；原 SSH 终端关闭或重连后，需要连接目标服务器并新建会话。普通未绑定会话保持未绑定，选择新的终端不会偷偷重新绑定。
- “历史”按模型读取 Rust 数据库，支持加载更多会话。完整回复显示持久结果；取消、失败和中断显示部分文本与实际状态，不会当成成功回复。
- 重读历史不会调用模型。历史中仍在生成的请求会短间隔刷新，也可手动刷新或停止该请求。硬退出遗留的请求在后端租约到期后标记为中断，不会自动重新生成。
- 点击旧用户消息的“恢复请求”可以放回输入框；手动重新发送会创建新的 requestId，属于新的模型请求。
- 上下文超限会提示新建会话或检查窗口设置；后续 C 阶段再实现自动压缩。

## 开发验证

在客户端目录运行：

```powershell
node --import tsx --test tests/agent-history.test.ts tests/agent-ipc.test.ts tests/ipc-transport.test.ts tests/chat-attachments.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
cargo test --manifest-path src-tauri/Cargo.toml --offline --lib backend_ipc::tests -- --test-threads=1
```

B4 验证：前端 37 项、原生 IPC 11 项通过，TypeScript 和生产构建通过，Clippy 无新增告警（保留两项既有告警）。本地模型/SSH 协议夹具不使用真实 Key 或用户服务器；没有实际供应商调用、完整桌面 GUI 验收或安装包构建。

实现：`src/components/ModelSettings.tsx`、`src/api/models.ts`、`src/state/agentHistory.ts`、`src/App.tsx`、`src-tauri/src/backend_ipc.rs`。模型后端仍为 [B1 适配器](../../ai-ssh-terminal-server-rust/docs/AGENT_MODELS.md)，阶段进度见 [AGENT_PROGRESS.md](../../ai-ssh-terminal-server-rust/docs/AGENT_PROGRESS.md)。
