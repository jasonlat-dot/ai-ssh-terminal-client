# Rust 后端实验

test-rust-ui 分支接入内置 Rust 后端，当前为 ShellPilot Rust Preview 0.4.0。

安装包将 React/Tauri 界面与 shellpilot_server 库编译为同一个 Windows 程序，无需另启 server 或安装 Java/MySQL。首次启动创建独立数据和设置，自动选择本机空闲端口；运行地址由 Tauri 状态同步给前端 API。

详见 RUST_PREVIEW_INSTALL.md。当前支持 SSH 连接配置与终端、本地 CMD、SFTP 文件管理/上传下载，以及本地文件与附件存储。顶部“文件与附件”支持已存历史、链接刷新、删除和容量查看，设置页可调整附件策略。AI 对话、模型附件处理及 Agent 工具仍待阶段 5 迁移。

开发独立服务可运行 npm run dev:rust-server，浏览器开发界面使用 http://127.0.0.1:8889。桌面模式使用 npm run tauri dev，由桌面启动内置服务。

~~~powershell
npm run bundle:nsis
npm run test:files:rust
~~~

第二条命令构建兄弟目录的调试 Rust server，再运行前端到实际文件服务的联调；测试使用临时目录，不访问用户已有附件或远端。

试用程序、应用标识和数据目录与 Java 版隔离，自动更新关闭。
旧 bundled_backend.rs 留作 Java 实现参考；实际编译入口由 lib.rs 指向 embedded_backend.rs。
后端附件协议和边界详见兄弟 Rust 后端 docs/FILES.md。
