# 运行日志与执行记录

当前说明对应 v0.2.2 内置 Rust 后端。桌面宿主实际编译 `src-tauri/src/embedded_backend.rs`，后端库来自兄弟目录 `ai-ssh-terminal-server-rust`；旧 Java 生命周期实现文件不代表当前运行路径。

## 文件日志

默认日志文件为：

```text
%LOCALAPPDATA%\com.jasonlat.shellpilot\logs\backend.log
```

该文件由桌面宿主追加工作区初始化、停止记录，时间使用 UTC。日志不会随每次启动清空，因此可能包含早期 Rust HTTP 实现的 `starting embedded Rust backend at http://...` 记录。当前版本记录 `initializing local workspace (IPC, no HTTP listener)`，不启动本机 HTTP 服务。

目前它**不记录每次模型请求、工具调度、模型返回或原始 HTTP 请求/响应**。一些初始化错误只通过启动状态事件及界面展示，并未完整写入该文件。后端少量 `tracing::warn!` / `error!` 在桌面宿主中尚无文件 subscriber；设置 `RUST_LOG` 本身不会补上文件输出。

新代码的请求与对话日志另存于：

```text
%LOCALAPPDATA%\com.jasonlat.shellpilot\logs\agent\YYYY-MM-DD\<traceId>.log
```

“本地工作区 → 诊断日志”可以打开该目录，选择 DEBUG / INFO / WARN / ERROR，默认 INFO。用户输入和保存后的模型回复以 `conversation.message` 记录，每条带 role、connectionName、modelId、state、message 及同一次请求的 traceId；普通对话的连接名为 null，流式回复合并后写入，历史回放不重复写正文。取消或失败的部分回复有明确状态。正文为本机明文日志，分享前请脱敏；不额外记录配置密钥、系统提示词或原始工具输出。调高至 WARN / ERROR 后，INFO 正文记录也会过滤。

重新启动开发应用并重新编译原生代码，或安装包含此功能的新包后才生效；仅刷新网页不会更新 Rust 库。开发评测程序自己的控制台输出和 `evals/` 下的测量文件不属于该日志。

新文件后缀为 `.log`，内容仍是每行一个 JSON 对象，逐条追加。旧 `.jsonl` 文件保留原名。“日志保留时间”默认 7 天，修改后立即保存；启动、保存日志设置时清理，工作区运行期间每小时检查。按本地日期保留最近 N 个自然日，过期 `.log` 和旧 `.json` / `.jsonl` 请求日志自动删除；不清理 backend.log、数据库或附件。

## 对话与执行记录

优先打开对应对话历史，展开工具、子任务、审批和原始输出。持久记录默认位于：

```text
%LOCALAPPDATA%\com.jasonlat.shellpilot\backend-data\shellpilot.sqlite3
```

如果修改过数据目录，以“本地工作区 → 数据与日志位置”显示的数据库路径为准。日志目录和 `workspace.json` 仍在应用根目录。

| 表 | 用途 |
| --- | --- |
| `agent_chat_turns` | 回合状态、最终/部分文本、错误码及已保存的 usage |
| `agent_events` | 对话与任务事件，包括工具调用和结果 |
| `agent_outputs` | 工具输出状态、大小、预览及过期时间 |
| `agent_output_chunks` | 有界、分块保存的工具输出字节 |
| `agent_workflow_events` | 子任务与工具开始等协作过程事件 |
| `agent_execution_requests` / `agent_extension_approvals` | SSH / 扩展工具审批记录 |

这些记录用于产品历史与恢复，不等于完整的逐次模型网络追踪。输出受容量、过期、取消和清理策略约束，并非所有原始输出永久保存；删除对话也会清理对应数据。

需要直接检查数据库时，使用 SQLite 工具以只读方式打开；以下仅查询元数据，避免一下子展开提示词、工具参数和输出正文：

```sql
SELECT session_id, request_id, state, error_code, created_at, updated_at
FROM agent_chat_turns
ORDER BY created_at DESC LIMIT 50;

SELECT id, session_id, task_id, kind, call_id, created_at
FROM agent_events
ORDER BY id DESC LIMIT 100;

SELECT id, session_id, call_id, channel, state, size, expires_at
FROM agent_outputs
ORDER BY created_at DESC LIMIT 50;
```

排查时保留问题发生时间、对应对话和错误码。不要将整个用户数据库、密钥、MCP 授权头或未经处理的服务器输出直接公开。本文仅说明当前实现，不会开启新的日志采集或修改用户数据。


### 从失败回复定位请求日志

桌面客户端的失败回复卡片在“恢复到输入框”旁提供“定位日志”。点击后，在系统文件管理器中打开并选中对应 Trace ID 的请求日志，不直接打开或执行日志内容，也不导出额外副本。

原生层只接收 Trace ID，在应用自己的 `logs/agent/YYYY-MM-DD/` 下只精确查找 `.log`；不接受前端传入的文件路径、不递归搜索其他目录。若请求跨越午夜，定位到最新日期的 `.log` 片段。跳过符号链接和 Windows reparse point。日志已过期清理、未生成或访问失败时，在原卡片内显示提示并允许重试，不改变对话、附件或输入草稿。

此入口需要更新后的 Rust 原生命令，首次使用需退出托盘旧进程并重新运行 `npm run tauri dev`；仅刷新页面无法注册新命令。纯浏览器模式不显示定位按钮。本次前端 483 项、原生库 58 项、TypeScript 及 Vite 构建通过；未进行实际资源管理器窗口的人工验收。
