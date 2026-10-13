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
| AI 对话和模型请求 | Rust Agent 尚未接入界面；后续前端通过 IPC/Channel 调用本地 Agent，由 Rust 访问模型服务 |

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

在桌面内置模式中，点击“文件与附件 → 选择文件并上传”打开系统文件选择器。Rust 逐个读取并上传所选文件，成功文件进入上传列表；失败文件显示错误提示。上传期间按钮显示“正在选择或上传文件…”。

点击已存附件的“下载”打开系统保存对话框。保存采用临时文件和原子发布，不覆盖已存在的目标；目标重名时请选择新名称。取消文件对话框不保存文件。

本地附件使用 `ipc://builtin/<实例ID>/files/<文件ID>` 引用，不生成 HTTP 签名下载链接，也不使用链接有效期。重新初始化后，从“已存储文件”列表重新打开，或点击“刷新附件”取得新实例引用。桌面程序不打开 HTTP 下载链接。

本地设置支持数据目录、自动初始化、附件启用、容量与保留天数。已移除监听端口、下载链接有效期；旧 `rust-backend.json` 中的 `serverPort`、`downloadLinkMinutes` 会被忽略，其余配置及数据继续沿用。重新初始化工作区会断开当前 SSH/SFTP 会话，不删除数据。

附件大小、类型、容量、SHA256、数据库记录及中断清理共用后端原有规则。内置模式不通过 JavaScript 读取整份文件，也不把文件内容序列化为 IPC JSON。

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
