# 内置 Rust 服务的 IPC 交互

本次改造用于 `test-rust-ui` 的 Rust Preview。前端不再通过 WebView HTTP 请求使用内置 SSH、SFTP 和附件服务，避免多个长轮询占满浏览器的 HTTP/1.1 并发连接。

## 业务使用什么

应用只有本地工作区，不再提供远程后端模式、后端地址、后端证书或档案切换。

| 业务 | 交互方式 |
|---|---|
| SSH 配置管理、连接、输入、窗口尺寸、关闭 | Tauri invoke → 应用内 Rust 服务 |
| SSH 持续输出和断线状态 | Tauri Channel |
| SFTP 操作、任务、取消、保存确认 | 原生文件桥 → 应用内 Rust SFTP Manager |
| SSH/SFTP 与目标服务器的通信 | Rust 直接连接目标服务器的 SSH 端口 |
| SFTP 文件内容 | Rust 文件句柄 ↔ SSH/SFTP 流，内容不经过前端 |
| SFTP 进度 | Rust 快照 → Channel |
| 附件上传和保存 | 系统选择/保存对话框 → Rust 文件句柄 |
| 附件列表、删除、容量、应用设置和历史 | invoke |
| 工作区就绪检查 | invoke |
| AI 对话和模型请求 | 本地 Rust Agent 通过 IPC/Channel 提供文字及显式启用的 SSH 工具轮次，由 Rust 访问模型服务；模型参数不携带审批权限 |

程序不启动本地 HTTP server。前端随应用打包为静态资源，内部功能没有 TCP 监听端口。`npm run tauri dev` 的 Vite 开发服务器仍使用 1420；安装版没有这个开发服务器。

旧版保存的远程后端地址、活动档案和证书不再生效，也不会发起连接。HTTP 地址不能作为应用内请求目标，原生远程 HTTP 转发命令已移除。旧本地页签可迁移至固定工作区存储键，SQLite 与附件目录继续沿用。

浏览器运行 `npm run dev` 仅可预览界面，不提供 SSH、附件或本地数据操作；这些功能需要 Tauri 桌面运行环境。Rust 项目已经移除独立 HTTP 程序入口，只作为业务库使用；库内历史协议测试适配不属于应用运行链路。

## 生命周期与输出控制

- 每个终端始终使用 Channel，并绑定创建时的工作区实例。重新初始化后，旧 sessionId 不会路由到新实例。
- Channel 输出按 UTF-8 边界分块，每帧最多 64 KiB。前端 xterm 完成当前帧写入后确认，Rust 才发送下一帧；最多一帧等待确认。
- 取消订阅只停止读取，不关闭 SSH shell。关闭终端仍需独立 invoke；其他终端不受影响。
- IPC 请求支持取消回执，包括取消先到、请求后到。变更操作取消后不能假定没有执行；需要读取实际状态，不自动重试。
- 每次初始化生成 `ipc://builtin/<实例ID>`，它只是内部身份，不是网址或监听地址。原生侧同时校验身份与服务实例，重新初始化后拒绝旧实例请求。本地终端页签使用固定工作区存储键，不因实例ID变化而丢失。
- 服务重启清理终端、SFTP 和附件服务。原 SFTP 会话保持对旧服务实例的引用，收到关闭状态后重新打开；不会悄悄切到新实例。

## 附件操作

在桌面内置模式中，通过聊天输入框的附件按钮打开系统文件选择器。Rust 逐个读取并上传所选文件，成功文件加入当前消息草稿；失败文件显示错误提示。顶栏独立文件管理入口及其上传列表已移除。

点击已存附件的“下载”打开系统保存对话框。保存采用临时文件和原子发布，不覆盖已存在的目标；目标重名时请选择新名称。取消文件对话框不保存文件。

本地附件使用 `ipc://builtin/<实例ID>/files/<文件ID>` 引用，不生成 HTTP 签名下载链接，也不使用链接有效期。重新初始化后，如旧引用不可用，可重新附加文件；已发送内容的预览使用会话快照。桌面程序不打开 HTTP 下载链接。

本地设置支持数据目录、自动初始化、附件启用、容量与保留天数。已移除监听端口、下载链接有效期；旧 `rust-backend.json` 中的 `serverPort`、`downloadLinkMinutes` 会被忽略，其余配置及数据继续沿用。重新初始化工作区会断开当前 SSH/SFTP 会话，不删除数据。

附件大小、类型、容量、SHA256、数据库记录及中断清理共用后端原有规则。原始文件上传/保存不通过 JavaScript 读取整份文件，也不把原始文件内容序列化为 IPC JSON。E1 的“查看发送内容”通过只读原生接口返回有大小上限的准备快照，供前台预览提取文字或缩放图片。

## 本机运行和验证

两个项目需要放在同一父目录：

```text
AIShellTerminal/
  ai-ssh-terminal-client/
  ai-ssh-terminal-server-rust/
```

在客户端目录运行：

```powershell
npm run prepare:backend
npm run tauri dev
```

第一条准备内置库的说明与许可证资源；第二条启动前端和 Tauri 桌面程序，由桌面启动内置 Rust 服务。业务库没有独立启动命令。

自动检查：

```powershell
npm run build
npx tsx --test tests/ipc-transport.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1
cargo test --manifest-path ../ai-ssh-terminal-server-rust/Cargo.toml
```

新增回归覆盖 8 个安静终端同时订阅时的输入、关闭与窗口隔离，Unicode 分块/确认，取消先于订阅，无 HTTP 监听的原生 SFTP 上传下载与取消，以及原生附件上传/超限/服务停止清理。

完整 GUI 文件选择、保存对话框和用户真实远端仍需桌面实际验证。本次没有生成安装包，也没有启用尚未迁移的 AI 功能。

已有 `tests/bundle-names.test.mjs` 的正式版名称断言与本分支 `ShellPilot-Rust-Preview` 配置不一致，会失败；这不是本次 IPC 修改引入的变化。


## 前一轮 IPC 改造验证记录（2026-10-13，仍保留 HTTP 监听的版本）

- Rust 后端：96/96 全量测试通过，fmt 检查通过；新增流式入口后 Clippy -D warnings 通过。
- Tauri 原生：21/21，包括 8 个 SSH 窗口的 Channel 订阅与输入、无 HTTP 的 SFTP 直连。
- 前端 TypeScript/业务：83/83，含新增 IPC/原生 HTTP 传输 7 项；TypeScript 检查及生产构建通过。
- 前端 mjs：177/178，唯一失败是上述已有正式版名称断言。原生 Clippy 保留 3 项旧代码警告，本次新增代码无警告。
- 未启动完整 GUI、未操作用户远端或真实模型、未运行文件对话框、未生成安装包、未提交 Git。


## 移除内置监听端口（2026-10-13）

本轮只修改源码、现有测试适配和文档，按用户要求未执行编译、构建、自动测试、应用启动或安装打包，也未提交 Git。上面的通过记录不代表本轮改动已经验证。用户可退出正在运行的旧开发程序，再执行 `npm run tauri dev`，检查 SSH 多窗口、SFTP、附件上传/保存和工作区重新初始化。


## 移除远程后端配置（2026-10-13）

已移除连接档案编辑/切换、后端证书信任、独立 HTTP 连接探测、原生 HTTP 转发、终端 HTTP 长轮询和 SFTP HTTP/SSE 适配。所有桌面业务统一使用 IPC。Rust Agent 仍按原进度继续迁移，此次没有启用 AI 功能。

按用户要求只改源码、测试适配和文档，未编译、运行测试、启动应用、打包或提交 Git。此前验证记录对应旧代码，不代表此次改动已验证。

独立入口清理：Rust 项目的 src/main.rs 与 Cargo [[bin]] 已删除，autobins=false。可在库目录执行 cargo build --lib/cargo test 独立编译或测试，运行完整应用使用客户端目录的 npm run tauri dev。本轮仍未实际执行这些命令。


## D5：原生 SSH 工具接入

`builtin_agent_subscribe` 增加可选的宿主参数 `executionEnabled`（缺省 false），不混入模型请求或 chat::Request。文字与工具轮次共享会话互斥、持久 requestId 回执、停止、租约恢复和逐帧 ACK；工具轮次通过 schema 13 的 agent_tool_turns 标记，未完成的批次在恢复时保守闭合为 unknown，不重新发送。

工具仅支持显式配置具备 function tools 能力的 Chat Completions 模型；Responses 继续保留文字能力。工具轮次的供应商请求是非流式的，Channel 仍逐帧传递真实工具调用、结果、上下文状态和最终回复。工具输出是有界预览，完整证据按原始字节回查。

| 原生业务入口 | 作用 |
| --- | --- |
| POST agent/execution_bind | 用户明确启用工具时，核对服务器持久身份和真实终端并固定 task/connection/terminal 目标；运行中禁止重绑 |
| GET agent/execution_requests | 用户/模型/会话隔离的审批历史，按原始游标分页，显示过期与授权撤销状态 |
| POST agent/execution_decision | approveOnce / approveTaskCommand / deny / cancel / revoke；同任务相同命令授权最多 5 分钟 |
| GET / POST agent/execution_policy | revision CAS 的 confirm / auto / fullAccess / deny；普通对话和服务器对话使用相同的对话级工具策略，禁止执行同时撤销已有授权 |
| GET agent/execution_output | 只读已关联输出，字节 offset/limit，单次至多 64 KiB；UI 每段 4 KiB，支持十六进制 |

切换终端页签不改变在途工具目标。SSH 命令使用同认证传输的独立无 PTY exec，不继承可见终端目录；停止生成不保证终止远端进程，admitted/unknown 均须先核查。禁用工具后仍可用文字讨论历史证据；断开 SSH 不影响已保存输出的读取。

普通对话和服务器对话的输入框都显示审核边界，默认“请求批准”，策略按当前用户和对话保存，不依赖 SSH 连接或活动任务。首条普通消息发送前的选择通过 `agent/create_session` 的可选 `approvalMode` 与会话在同一事务中保存；已有对话通过 `agent/execution_policy` 读取和修改。同一对话重新绑定任务仍使用同一审核模式，但单次批准、精确命令授权和目标验证仍独立校验，不跨任务复用。

工具能力开关与 SSH 绑定分离：普通对话不注册 SSH 工具，服务器对话只有在目标绑定可用时才注册 SSH。所有持久化工具轮次必须在 `ToolLoop` 安装对话级 `ApprovalBoundary`，每次分派先读取统一模式，再调用工具适配器的 `authorize_with_policy`。`deny` 阻止所有工具分派；`confirm` / `auto` 要求适配器接入可信的人工/审查授权，缺失时默认拒绝；`fullAccess` 仍须通过适配器自身的访问边界。当前已接入 SSH 和工具输出回查，MCP 客户端及其他通用工具尚未注册，后续也必须通过此公共入口接入。

前台验证入口：模型设置 → 高级参数 → 函数工具能力；选择项目/服务器聊天并连接对应服务器 → 发送任务 → 审批与记录中确认/拒绝 → 查看工具结果及原始输出。当前不提供本地 shell、多 Agent 或 Responses 工具调用。所有阶段验证结果与实际 GUI 限制统一以 Rust 仓库 docs/AGENT_PROGRESS.md 为准。


## E1：聊天附件

聊天提交仅携带附件 fileId。Rust 通过同一文件服务校验上传归属及摘要，并生成会话内不可变快照；Chat Completions 与 Responses 分别使用原生媒体输入，不发送 ipc:// 文件引用给供应商。历史返回附件元数据。GET agent/attachment 要求 agentId/userId/sessionId/fileId，只读返回已关联该会话的 reference 与 text/imageUrl，不调用模型或 SSH。系统选择器的可选 chatOnly/chatLimit 参数限制聊天类型、数量和大小；原生附件服务继续供聊天使用。

图片能力、PDF 文字提取范围和前台操作见 agent-model-settings.md；验证统一记录于 Rust docs/AGENT_PROGRESS.md。上述 D5 节的手动启用开关及独立 exec 说明属于历史状态，当前执行模式见最新进度。


### E1 图片缩略图与剪贴板导入

`builtin_clipboard_upload(backendUrl,onEvent,chatLimit,chatBytes)` 仅由输入框粘贴动作调用。原生读取剪贴板：Windows CF_HDROP 文件列表优先，其次图片、文字；文件在原生打开并经过聊天白名单、剩余数量和字节预检，图片编码为 PNG 后复用文件存储。返回普通文字或通过 Channel 返回文件引用，浏览器不传本机文件路径/原文件字节。Ctrl+V 和菜单粘贴共用该入口，导入过程阻止漏发附件，迟到事件按草稿范围丢弃。

聊天模式下 `builtin_pick_upload` 与粘贴上传事件为图片附带临时 previewUrl；该值是受限缩放 JPEG，不写入历史元数据。`builtin_attachment_preview(backendUrl,fileId)` 仅按当前实例的本地用户文件记录生成草稿缩略图，不接受路径/地址；历史仍通过 agent/attachment 按原会话读取准备快照。图片预览复用 Rust Agent 的 image_preview 解码/尺寸/编码限制，原生预览并发为 2。此接口与模型/SSH 调用无关。


聊天附件原生导入的 Channel 增加 `preparing` 事件（id、fileName、size），在整批预检成功后、存储上传前逐文件发送；`uploaded` 使用相同临时 id 关联完成。聊天系统选择器与复制文件复用同一预检/导入流程。前端据此呈现逐文件圆形准备指示，成功、失败、取消/普通文字粘贴完成时清理临时卡片，旧草稿范围的迟到进度不进入新会话。准备事件不携带文件正文或可执行路径，也不代表字节百分比。
