# 运行日志与执行记录

当前说明对应 v0.2.1 内置 Rust 后端。桌面宿主实际编译 `src-tauri/src/embedded_backend.rs`，后端库来自兄弟目录 `ai-ssh-terminal-server-rust`；旧 Java 生命周期实现文件不代表当前运行路径。

## 文件日志

默认日志文件为：

```text
%LOCALAPPDATA%\com.jasonlat.shellpilot\logs\backend.log
```

该文件由桌面宿主追加工作区初始化、停止记录，时间使用 UTC。日志不会随每次启动清空，因此可能包含早期 Rust HTTP 实现的 `starting embedded Rust backend at http://...` 记录。当前版本记录 `initializing local workspace (IPC, no HTTP listener)`，不启动本机 HTTP 服务。

目前它**不记录每次模型请求、工具调度、模型返回或原始 HTTP 请求/响应**。一些初始化错误只通过启动状态事件及界面展示，并未完整写入该文件。后端少量 `tracing::warn!` / `error!` 在桌面宿主中尚无文件 subscriber；设置 `RUST_LOG` 本身不会补上文件输出。

这属于尚未接通的诊断能力，不是换了日志路径。开发评测程序自己的控制台输出和 `evals/` 下的测量文件也不是正式安装版自动生成的运行日志。

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
