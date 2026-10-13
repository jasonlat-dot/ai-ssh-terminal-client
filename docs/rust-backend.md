# Rust 后端实验

test-rust-ui 分支接入内置 Rust 后端，当前为 ShellPilot Rust Preview 0.4.0。

安装包将 React/Tauri 界面与 shellpilot_server 库编译为同一个 Windows 程序，无需另启 server 或安装 Java/MySQL。首次启动创建独立数据和设置；内置功能全部使用 IPC，不启动本地 HTTP 服务，不占用本机监听端口。

详见 RUST_PREVIEW_INSTALL.md。当前支持 SSH 连接配置与终端、本地 CMD、SFTP 文件管理/上传下载，以及本地文件与附件存储。顶部“文件与附件”支持已存历史、原生保存、删除和容量查看，设置页可调整附件策略。AI 对话、模型附件处理及 Agent 工具仍待阶段 5 迁移。

桌面模式运行 `npm run tauri dev`，功能通过应用内部 IPC 完成；普通浏览器只预览界面，不访问外部后端。

~~~powershell
npm run bundle:nsis
npm run test:files
~~~

第二条命令运行附件 IPC 与队列回归，不访问用户已有附件或远端。本轮按用户要求尚未执行。

试用程序、应用标识和数据目录与 Java 版隔离，自动更新关闭。
旧 bundled_backend.rs 留作 Java 实现参考；实际编译入口由 lib.rs 指向 embedded_backend.rs。
后端附件协议和边界详见兄弟 Rust 后端 docs/FILES.md。

内置业务现通过 invoke/Channel 调用 Rust 服务，不再提供远程后端模式、地址配置或证书配置。具体分工、启动命令与验证边界见 [ipc-transport.md](ipc-transport.md)。

`npm run tauri dev` 中 Vite 的 1420 端口仅用于开发，安装后的应用不需要它。本轮移除监听端口的改动由用户自行运行验证，未重新打包。

Rust 项目现为纯业务库，独立 HTTP main.rs/二进制入口已移除。业务库可单独编译和测试；运行桌面应用由 Tauri 初始化该库，无需先生成安装包。
