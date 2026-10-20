# ShellPilot · 终端领航

ShellPilot 是基于 React、TypeScript、Tauri 2 和 Rust 的 Windows 智能终端客户端。当前版本为 **v0.2.2**，支持本地 CMD、SSH 终端、SFTP 文件管理，以及带工具审批、子任务、MCP、Skills 和长期记忆的 AI 对话。

Rust 后端作为库直接链接进桌面程序，前端通过 Tauri IPC 调用同一应用内的服务。桌面版不启动本机 HTTP 监听，不需要填写后端地址，也不依赖 Java、JAR、JRE、Maven 或独立数据库服务。模型 API、远程 SSH 与 MCP 仍按各自配置连接。

## 两个仓库

| 仓库 | 职责 |
| --- | --- |
| [ai-ssh-terminal-client](https://github.com/jasonlat-dot/ai-ssh-terminal-client) | React 界面、Tauri 原生宿主、本地 CMD、桌面 IPC、更新及安装包 |
| [shell-pilot-rust](https://github.com/jasonlat-dot/shell-pilot-rust) | Rust 后端库：SSH、SFTP、附件、SQLite、Agent 执行与上下文、MCP、Skills、记忆 |

开发和打包时，需要将两个仓库放在同一个父目录。后端 GitHub 仓库名为 `shell-pilot-rust`，**本地目录必须命名为 `ai-ssh-terminal-server-rust`**，与客户端 Cargo 路径依赖一致：

```text
AIShellTerminal/
├── ai-ssh-terminal-client/
│   ├── src/                   React 前端
│   ├── src-tauri/             原生宿主与桌面 IPC
│   ├── scripts/               构建与发布脚本
│   └── docs/                  使用与发布说明
└── ai-ssh-terminal-server-rust/
    ├── src/                   后端库
    ├── migrations/            SQLite 迁移
    ├── tests/                 后端回归
    ├── evals/                 模型评测与验收记录
    └── docs/AGENT_PROGRESS.md  实施进度与验证边界
```

客户端 `src-tauri/Cargo.toml` 通过 `../../ai-ssh-terminal-server-rust` 引用后端库。最终用户只需安装客户端，不需要克隆两个仓库或另外启动后端。

## 功能

- 本地 CMD、SSH 交互终端、多会话与分屏、页签排序、常用命令。
- 双栏 SFTP 浏览、上传下载、传输进度与取消；支持 SSH 登录身份和 sudo root 访问。
- 普通对话和固定服务器目标的任务对话；服务器工具使用绑定终端的当前 POSIX Shell。
- 请求批准、自动审查、完全访问三种审批边界。MCP 与其他注册工具也遵循当前边界，普通对话不注册 SSH 工具。
- 有界子 Agent 协作、独立任务并行、执行过程和工具输出回查。
- MCP JSON 配置与高亮，支持 Streamable HTTP、旧版 SSE 和 stdio；Skills 目录按需读取。
- 全局或服务器范围的长期记忆，支持筛选、编辑、启停与删除。
- 图片、UTF-8 文本及可提取文字的 PDF 附件，长对话自动整理与历史恢复。
- 一个渠道配置多个模型，对话内切换模型并保留记录；按兼容协议选择推理强度。
- 按 Trace ID 定位失败请求日志，默认保留 7 天；展开工具可读取并复制已保存的完整输出。
- 明暗主题、壁纸与字体设置、紧凑窗口布局、统一操作提示及应用更新。

Chat Completions、Claude Messages、Responses 与 Google Gemini GenerateContent 支持文字、附件和工具调用；按协议自动保留推理字段或思考签名，历史恢复与上下文整理保留所需的尾部状态。Gemini 可选择原生 Google 入口或已有 OpenAI 兼容入口，供应商能力和入口说明见 [模型设置](docs/agent-model-settings.md)。扫描 PDF/OCR、Office 内容解析、旧 Java 数据自动导入及递归子任务不在当前支持范围。SFTP 使用独立连接，终端 `sudo` 不会自动改变文件连接的身份，需要在文件窗口选择访问身份。

## SSH 新手指引

首次操作服务器时，可以从终端空态的“查看连接指引”或左侧对话区的“连接指引”进入新手引导：保存 SSH 连接 → 创建并绑定服务器项目 → 新建项目对话。引导支持复用已有配置；完成表单后返回当前流程，未配置模型时可前往模型设置。示例任务只填入输入框，需自行确认发送。

## 窗口与系统托盘

点击窗口右上角 X 或按 Alt+F4 会隐藏到系统托盘，工作区不会停止，SSH 会话、智能体任务和文件传输继续运行。左键点击托盘图标，或右键选择“打开 ShellPilot”，可以恢复窗口。

应用采用单实例运行：从任务栏固定图标、开始菜单或快捷方式再次启动，会恢复已有窗口并切到前台，继续原来的会话和任务。

需要完全退出时，在托盘图标上右键选择“退出”。真正退出会停止内置工作区并关闭本地 CMD；安装更新仍会先清理会话再执行安装。最小化按钮仍按正常窗口最小化处理。

托盘由原生宿主创建，更改托盘功能后需重新启动桌面开发进程，或重新构建并安装应用；仅 Vite 热更新无法启用。

## 开发环境

Windows 桌面开发需要：

- Node.js 20.19+ 或 22.12+，也支持 Node 24。
- Rust stable MSVC 工具链。
- Visual Studio C++ Build Tools / Windows SDK。
- Microsoft Edge WebView2 Runtime。

首次拉取：

```powershell
git clone https://github.com/jasonlat-dot/ai-ssh-terminal-client.git
git clone https://github.com/jasonlat-dot/shell-pilot-rust.git ai-ssh-terminal-server-rust
cd ai-ssh-terminal-client
npm ci
npm run tauri dev
```

拉取后续更新时，两个仓库都需要更新到相互兼容的代码；客户端依赖变化后重新执行 `npm ci`。原生代码或窗口尺寸限制改变后，需要重新编译并重启 Tauri；仅前端修改通常由 Vite 热更新。

只预览网页界面可运行 `npm run dev`，但普通浏览器无法使用桌面 IPC、本地终端、内置 SSH/SFTP 等原生功能，不能代替桌面联调。

dev、tauri、build、preview 脚本会选择兼容的 Node 运行时；可用 `SHELLPILOT_NODE` 指定已有 `node.exe`，不会修改系统全局 Node。 Tauri dev/build 还会优先使用 PATH 中可运行的 Cargo；找不到时检查 `CARGO_HOME/bin` 和用户目录的 `.cargo/bin`，只补齐子进程环境，不修改系统 PATH。未安装或无法运行 Rust 工具链时给出明确提示。

## 构建和发布

在客户端目录执行。两个仓库都必须存在，Cargo 会将 Rust 后端库编译到桌面程序，不另外打包 server.exe、JAR 或 JRE。

普通安装包：

Windows 安装后的主程序为 `ShellPilot.exe`，开始菜单入口为 `ShellPilot`。安装和更新会补建缺失的开始菜单快捷方式（显式使用 `/NS` 禁用快捷方式时除外）。v0.2.2 沿用正式应用标识及原工作区，安装前请从托盘退出旧版。

```powershell
npm run bundle:nsis     # NSIS EXE
npm run bundle:msi      # MSI
npm run bundle:windows  # 两种格式
```

默认输出：

```text
src-tauri/target/release/bundle/nsis/ShellPilot_<版本>_x64-setup.exe
src-tauri/target/release/bundle/msi/ShellPilot_<版本>_x64_en-US.msi
```

正式发布及自动更新使用签名发布命令：

```powershell
# 继续使用与配置公钥匹配的原有签名私钥；无密码时填空字符串。
$env:TAURI_SIGNING_PRIVATE_KEY = '你的签名私钥文件绝对路径'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '你的私钥密码'
npm run release:windows -- --notes docs/releases/v0.2.2.md
```

发布脚本构建 Windows x64 NSIS 安装包、验证签名，并在 `release/v0.2.2/` 生成安装包、`.sig`、`latest.json`、发布说明与 SHA256 校验文件。脚本不会自动上传 GitHub 或安装更新，也不会覆盖已有的同版本发布目录。普通 `bundle:*` 不会生成完整的签名更新发布目录。

将安装包、对应 `.sig` 与 `latest.json` 一起上传到 `v0.2.2` 的 GitHub 正式 Release。更新通道沿用原客户端仓库的 GitHub Releases；通道读取最新正式 Release，与代码分支无关。不要更换已有签名密钥。

“关于与更新”可以检查、下载并确认安装。开发模式不检查或安装更新；正式版启动后约 3 秒静默检查一次，无更新或失败不打扰，有更新时提示，不自动下载或安装。详见 [更新与发布说明](docs/client-updates.md)。

应用图标来源于 `public/icon.svg`，开发启动和打包前自动同步原生图标；可单独运行 `npm run prepare:icons`。生成的构建资源及私钥不应提交。

## 数据与配置

默认 Windows 数据根目录：

```text
%LOCALAPPDATA%/com.jasonlat.shellpilot/
├── workspace.json          工作区配置与自动初始化设置
├── backend-data/
│   ├── shellpilot.sqlite3     连接、模型、对话、工具事件、记忆等
│   └── attachments/           本地附件
└── logs/
    ├── backend.log            工作区初始化、停止记录
    └── agent/YYYY-MM-DD/<traceId>.log  请求诊断与对话正文
```

从旧预览版首次升级时，启动会在创建 WebView 前，将旧预览版目录复制到正式目录，包括数据库、附件、配置及 WebView 持久数据。旧目录保留为备份；已经初始化的正式目录不会被覆盖。原配置指向旧根目录内的位置会同步改为新路径，外部自定义数据目录保持原位置。旧 Java 版的 `%USERPROFILE%/.ai-ssh-terminal` 不在本次自动迁移范围内。

在“本地工作区”可调整数据目录、附件存储、容量与保留天数，并展开“数据与日志位置”查看实际路径。数据目录改动不会自动搬迁旧数据；重新初始化后使用新目录。配置文件与 `logs` 仍在应用根目录，不随数据目录移动。

附件容量默认 1024 MiB，保留天数 0 表示长期保留；正数会自动清理超过保留时间的已有附件。目录与附件设置保存后需重新初始化，启动时自动初始化开关立即保存。重新初始化或停止工作区会断开当前连接。

SSH 凭据在 Windows 上使用当前用户 DPAPI 加密。客户端常用命令等缓存仍由原生缓存模块管理，优先在可执行文件旁的 `.cache`，无法解析目录时按开发/平台路径回退；Agent 正式历史以工作区 SQLite 为准。

## 日志与问题排查

`logs/backend.log` **目前仅是工作区生命周期日志**，不是 Java 版的后端控制台日志。文件只有初始化和停止记录是当前实现的实际行为；它不包含逐次模型请求、提示词、模型响应、工具参数或完整执行输出。最早出现的 `http://...` 行可能是该文件累计保留的旧实现记录，当前桌面版使用 IPC。

- 查看实际执行过程：打开对应对话历史，展开工具或子任务卡片、审批与原始输出。
- 数据排查：SQLite 中的 `agent_chat_turns`、`agent_events`、`agent_outputs` / `agent_output_chunks`、`agent_workflow_events` 等保存不同层面的回合和工具记录；这些不是完整的模型 HTTP 流量日志。
- 请求日志写入 `logs/agent/YYYY-MM-DD/<traceId>.log`。在“本地工作区 → 诊断日志”切换级别；默认 INFO 包含用户消息与保存后的模型回复，附带连接名、实际模型 ID、状态及 Trace ID。正文在本机明文保存，分享前需脱敏；配置密钥、系统提示词和原始工具输出不额外写入。该目录不由 `RUST_LOG` 控制，`backend.log` 仍仅记录工作区生命周期。

更多位置、查询与限制见 [运行日志与执行记录](docs/runtime-logs.md)。

“诊断日志 → 日志保留时间”默认 7 天，独立保存后立即生效；工作区启动、日志设置保存及运行期间每小时清理过期的请求日志，兼容旧 `.json` / `.jsonl` 文件。新文件使用 `.log` 后缀，仍逐行追加 JSON 对象；数据库、附件和 backend.log 不在该清理范围内。

## 验证命令

以下命令供开发者按需运行，不表示每次文档或界面修改都已执行：

```powershell
# 客户端类型检查与前端构建
npm run build

# 原生与所链接后端的桌面宿主测试
cargo test --manifest-path src-tauri/Cargo.toml --all-targets

# 在兄弟后端目录运行后端套件
cd ../ai-ssh-terminal-server-rust
cargo test --all-targets
```

真实模型、SSH、SFTP 与第三方 MCP 的验收有额外配置和实际用量，不能用普通界面预览代替。实施状态和历史证据位于后端仓库 `docs/AGENT_PROGRESS.md` 与 `evals/`；E4 旧数据迁移仍按计划暂缓。

## 相关说明

- [v0.2.2 发布说明](docs/releases/v0.2.2.md)
- [v0.2.2 升级与发布](docs/releases/v0.2.2-upgrade.md)
- [Rust 内置架构](docs/rust-backend.md)
- [安装与数据目录](docs/INSTALL.md)
- [运行日志与执行记录](docs/runtime-logs.md)
- [自动更新与发布](docs/client-updates.md)
- [模型设置](docs/agent-model-settings.md)
- [官网自动部署](docs/website-auto-deploy.md)
