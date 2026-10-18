# ShellPilot Rust 内置架构

当前版本为 ShellPilot v0.2.1。完整开发与发布流程见 [README](../README.md)。

## 双仓库职责

- `ai-ssh-terminal-client`：React / TypeScript 界面，Tauri 2 原生宿主，本地 CMD、桌面 IPC、安装和更新。
- `shell-pilot-rust`：Rust 后端库，负责 SSH、SFTP、附件、SQLite、Agent、审批、上下文、长期记忆、MCP 和 Skills。本地检出目录必须为 `ai-ssh-terminal-server-rust`，位于客户端旁边。

客户端 Cargo 路径依赖为 `../../ai-ssh-terminal-server-rust`。后端库链接进同一个桌面程序，不打包独立 server.exe、Spring Boot JAR 或 Java Runtime。最终用户不需要安装 Node、Rust、Java 或 MySQL。

`src-tauri/src/lib.rs` 使用 `embedded_backend.rs` 作为工作区宿主。功能通过 Tauri IPC 与原生 Channel 在应用内部调用，不启动 HTTP 监听；`ipc://builtin/<实例 ID>` 是内部实例标识，不是可在浏览器访问的服务地址。后端库保留的 HTTP 适配代码不代表桌面版使用 HTTP 部署。

## 状态和数据

工作区初始化、停止和重新初始化由原生宿主管理，React 订阅状态。启动页至少展示 2 秒，服务就绪后才进入工作区。

默认配置与数据位于 `%LOCALAPPDATA%/com.jasonlat.shellpilot/`，配置文件为 `workspace.json`。v0.2.1 首次启动复制旧预览版工作区并保留原目录备份；外部自定义目录继续使用原位置。设置中手动修改数据目录不会搬迁数据，旧 Java 数据没有自动导入。

工作区历史与工具执行事件保存在 SQLite，`logs/backend.log` 当前只记录初始化和停止。桌面版尚无完整模型/工具文件诊断日志，详见 [日志与执行记录](runtime-logs.md)。

## 运行与发布

```powershell
npm ci
npm run tauri dev
```

普通浏览器的 `npm run dev` 仅供界面预览，不能替代原生 IPC 联调。

普通安装包使用 `npm run bundle:nsis`；签名发布使用 `npm run release:windows -- --notes docs/releases/v0.2.1.md`。正式安装版沿用客户端 GitHub Releases 更新通道及现有签名公钥，开发模式禁用更新。详见 [发布说明](client-updates.md)。

支持边界及最新验收证据以兄弟后端仓库 `docs/AGENT_PROGRESS.md` 为准。历史文件中的 Rust Preview 0.4.0、AI 尚未开放、自动更新关闭等描述属于早期阶段，不作为当前版本说明。
