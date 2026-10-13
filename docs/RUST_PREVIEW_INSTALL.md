# ShellPilot Rust Preview 0.4.0 试装说明

客户端分支：test-rust-ui。Windows x64，中文 NSIS 安装程序。
程序名 shellpilot-rust-preview.exe，应用标识 com.jasonlat.shellpilot.rust-preview；可与原 ShellPilot 并存。

## 安装和使用

1. 运行 ShellPilot-Rust-Preview_0.4.0_x64-setup.exe。
2. 打开 ShellPilot-Rust-Preview，内置 Rust 服务自动启动并选择空闲本机端口；不需要 Java、MySQL、Node 或 Rust 开发工具。
3. 添加 SSH 连接，输入密码或私钥。默认开启主机密钥检查，需要目标服务器匹配的 known_hosts 公钥记录。
4. SSH 终端支持原始输入、多窗口/分屏、命令库及本地 CMD。文件夹按钮打开双栏 SFTP 文件管理，支持目录/普通文件操作、上传下载、进度、取消和失败重试。
5. 顶部“文件与附件”支持本机附件上传，无需 SSH；在“已存文件”中查看历史、下载、刷新过期链接、确认删除。
6. “客户端设置”支持服务启动/停止/重启、端口/数据目录、自动启动，以及附件启用、容量、保留天数和下载链接有效期。

附件默认单文件最多 20 MiB、总容量 1 GiB、长期保留、链接有效 15 分钟。
支持 png/jpg/jpeg/webp/pdf/txt/log/csv/json/yaml/yml/md/docx/xlsx。网络失败后上传可能已保存，重试需手动操作；移除上传记录只移除本地行，删除已存文件需明确确认。

保留天数 0 表示长期保留，正数按创建时间清理，包括此前已存文件。
设置保存后需重启服务。重启会断开 SSH/SFTP，旧下载链接失效，在已存文件中刷新即可。
数据目录变更不会搬迁数据；默认 SQLite 与 attachments 位于：
%LOCALAPPDATA%\com.jasonlat.shellpilot.rust-preview\backend-data。
旧 0.3.0 配置自动补齐附件默认值，0.4.0 沿用同一份 Rust Preview 数据。

## 当前范围

已支持连接管理、密码/私钥认证、主机密钥验证、SSH PTY、读写/resize、多窗口、取消/断线状态、本地 CMD、命令库、SFTP 和本地附件存储。
AI 对话、聊天模型附件处理及自动执行任务仍属下一阶段，内置模式暂未启用相应入口。
与 Java 版数据独立，不自动导入旧 MySQL 或附件。SSH 凭据由当前 Windows 用户 DPAPI 加密。
自动更新关闭，后续使用新版试用安装包升级。原 Java 服务端源码未修改。

## 构建

需要 Node 22.12+（本次使用 24.19）、Rust MSVC、Windows SDK/C++ Build Tools，兄弟目录 ai-ssh-terminal-server-rust 必须存在。

~~~powershell
npm ci
npm run bundle:nsis
~~~

Cargo 将后端库链接进 Tauri 主程序，不打包 JAR/JRE 或独立后端 exe。
Tauri 使用 WebView2；缺少运行时的电脑由安装器按标准流程处理。

## 验证

后端 60 项测试、cargo fmt、Clippy -D warnings 通过，包括 16 项附件存储测试及既有 SSH/SFTP 回归。
前端 69 项回归及 1 项连接真实 Rust 文件服务的联调通过，覆盖上传、下载、过期刷新、队列并发、历史、删除和容量回收。
15 项原生桌面测试通过，命令须串行：cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1。
NSIS 安装包已生成：8399302 字节，主程序 16868864 字节。成品桌面实际启动，健康 UP、同进程附件上传/SHA256/下载/元数据/容量/删除及 SFTP 路由回归通过，停止程序后监听端口释放。
完整 GUI 点击、实际安装及用户远端验证仍由用户试装；协议测试使用本地临时服务，未操作用户实际远端服务器。

旧安装包保留在 releases 目录。SFTP 边界见兄弟后端 docs/SFTP.md，附件策略见 docs/FILES.md。


安装包 SHA256：82D6BD0C4D17A9BEC6B7E4DC36AAD82949A62202C08F59EF93F7DA0661BDED65
