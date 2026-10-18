# ShellPilot v0.2.1 安装与数据说明

当前发布目标为 Windows x64，使用 Tauri + 内置 Rust 后端。主流程见 [README](../README.md)，当前版本说明见 [v0.2.1](releases/v0.2.1.md)。

## 安装和使用

1. 运行 `ShellPilot_0.2.1_x64-setup.exe`。
2. 打开 ShellPilot，等待本地工作区就绪。后端在应用内部通过 IPC 运行，无需启动 Java、独立后端或数据库服务。
3. 在模型设置中配置模型服务；普通对话可使用已配置的扩展工具，服务器任务另行绑定 SSH 目标。
4. 从连接管理添加 SSH 主机，使用终端按钮建立远程会话；新建终端也可直接打开本地 CMD。
5. 从服务器的文件管理入口打开 SFTP，选择 SSH 登录身份或 sudo root 身份。文件连接独立于终端，身份不会随终端 sudo 自动切换。
6. 从输入框添加图片、文本或可提取文字的 PDF。附件存储格式和模型内容解析能力是两件事；扫描 PDF/OCR 与 Office 内容解析尚未提供。

## 数据位置

默认应用目录为：

```text
%LOCALAPPDATA%\com.jasonlat.shellpilot\
├── workspace.json
├── backend-data\
│   ├── shellpilot.sqlite3
│   └── attachments\
└── logs\
    └── backend.log
```

v0.2.1 首次启动会复制旧预览版工作区到正式应用目录，旧目录保留作备份。数据库、附件、启动配置和 WebView 持久数据一起迁移；原数据目录在旧应用根目录内时改为新路径，外部自定义目录保持原位置。迁移失败时启动报错，不使用部分复制的数据。已经初始化的正式工作区不会被覆盖。旧 Java 目录 `%USERPROFILE%/.ai-ssh-terminal` 不会自动导入。

“本地工作区”显示实际数据库、附件和日志位置。数据目录变更不会自动搬迁旧数据，重新初始化后使用新目录；配置和日志仍在应用根目录。修改目录、附件容量及保留时间后需重新初始化，这会断开已有连接。

附件容量默认 1024 MiB，0 天为长期保留；正数会清理超过期限的已有附件。SSH 凭据在 Windows 上使用当前用户 DPAPI 加密。

`backend.log` 目前只记录工作区初始化、停止；它不包含每次模型请求或工具输出。相关执行记录保存在 SQLite，可从对话历史展开，详见 [运行日志与执行记录](runtime-logs.md)。

## 开发和发布

开发需要 Node 20.19+ 或 22.12+、Rust MSVC 工具链和 Windows C++ Build Tools / SDK。两个仓库必须放在同级目录，后端本地目录名为 `ai-ssh-terminal-server-rust`。

```powershell
npm ci
npm run tauri dev

# 普通安装包
npm run bundle:nsis

# 已配置原有签名私钥环境变量后生成正式更新发布文件
npm run release:windows -- --notes docs/releases/v0.2.1.md
```

无需 JDK、Maven、jlink 或 JRE。WebView2 为桌面运行时依赖。

正式版“关于与更新”沿用旧客户端的 GitHub Releases 通道，发布时需上传签名安装包、匹配的 `.sig` 和 `latest.json`；开发模式不检查或安装更新。发布脚本不自动上传。历史 0.4.0 试装结果不等于当前 v0.2.1 安装包已经构建或验收，验证记录以实际批次为准。
