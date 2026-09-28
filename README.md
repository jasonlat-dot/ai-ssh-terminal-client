# ai-ssh-terminal-client
ai-ssh-terminal-client

## 拉取更新后启动

代码更新可能包含新的 npm 依赖，`git pull` 不会同步本地 `node_modules`。请先停止正在运行的 Vite/Tauri 开发进程，在项目目录执行：

```powershell
npm install
npm run dev
```

使用桌面开发模式时，将最后一行替换为 `npm run tauri dev`。

若出现 `Failed to resolve import "rehype-highlight"` 或 `"remend"`，说明本地没有安装到新增的 Markdown 依赖。它们已经记录在 `package.json` 和 `package-lock.json` 中，执行上面的安装命令即可，不需要修改 import。安装后可用 `npm ls rehype-highlight remend --depth=0` 确认；若 Vite 仍保留旧的依赖缓存，可用 `npm run dev -- --force` 重新启动。

代码块右上角的“复制文本”在生成中也可使用，复制点击时已显示的代码正文，不含语言标签、Markdown 围栏或高亮标签；后续生成不会修改已复制的内容。工具结果展开后可分别“复制命令”“复制输出”，整条回复仍在完成后提供 Markdown 复制。


## 安装后的后端地址设置

Windows 安装包默认连接随客户端自动启动的 `http://localhost:8888`。如果需要改用独立部署的后端，可在左侧导航栏“设置”中填写服务器根地址，例如 `https://api.example.com` 或 `http://192.168.1.10:8888`。不要附加 `/agent` 或 `/api/v1/ssh`；应用会分别拼接接口前缀。保存后的地址会覆盖本机默认值，重启仍然有效，**无需重新打包或安装**。切换服务器前请停止正在生成的对话并关闭远程终端标签，以免不同服务器的会话混用。

“测试连接”会请求目标服务器的 `/agent/query_ai_agent_config_list`。客户端仍通过 WebView 的 `fetch` 调用后端，因此跨域部署时后端或反向代理必须允许客户端来源（Windows Tauri 正式版通常为 `http://tauri.localhost`；本地开发为 `http://localhost:1420`），并正确处理跨域预检请求。若后端启用 HTTPS，请使用有效证书。没有保存自定义地址时，开发模式和正式安装包都默认连接 `http://localhost:8888`。

## Windows 打包

安装包会同时包含：

- Tauri 前端客户端；
- Spring Boot 后端可执行 JAR；
- 由当前 JDK 生成的 Java Runtime，最终用户不需要安装 Java；
- 首次启动使用的 `application.yml` 和 `application-prod.yml` 默认模板。

打包电脑需要安装 JDK 25、Maven、Node.js、Rust/MSVC 和 WebView2 构建工具。先确认：

```powershell
java -version
jlink --version
mvn -version
npm install
```

然后在 `ai-ssh-terminal-client` 目录执行：

```powershell
# 当前 JAVA_HOME 不是 JDK 25 时，可只为打包指定 JDK，不影响系统全局配置。
$env:BUNDLE_JAVA_HOME = "C:\Users\Administrator\.jdks\jdk25"
npm run bundle:windows
```

该命令会依次构建后端 JAR、通过 `jlink` 生成内置 Java Runtime、构建前端，并同时生成 NSIS 与 MSI 安装程序。结果位于：

```text
src-tauri/target/release/bundle/nsis/*-setup.exe
src-tauri/target/release/bundle/msi/*.msi
```

如果只需要其中一种格式，可以使用：

```powershell
# 只生成 NSIS EXE 安装包
npm run bundle:nsis

# 只生成 MSI 安装包
npm run bundle:msi
```

打包生成的临时资源位于 `src-tauri/bundle`，已加入 `.gitignore`，不要手工提交 JAR 和 Java Runtime。

### 安装后的后端目录

客户端首次启动时，会在当前用户主目录创建统一后端数据目录：

```text
%USERPROFILE%\.ai-ssh-terminal\
├── application.yml
├── application-prod.yml
├── data\
│   └── ai-ssh-terminal.db
├── uploads\
└── logs\
    └── backend-console.log
```

统一根目录由 `application.yml` 中的 `app.config.data-directory` 配置，默认值为
`${AI_SSH_TERMINAL_HOME:${user.home}/.ai-ssh-terminal}`。改成其他绝对路径并重启客户端后，
客户端会把现有内容复制到新目录，后续配置、SQLite、上传文件和日志都从新目录读写。

初始化只检查 `application.yml`：

- 如果 `application.yml` 不存在，复制默认的 `application.yml` 和 `application-prod.yml`。
- 如果 `application.yml` 已存在，不复制、不覆盖任何 YAML；用户可以自行使用 `application-dev.yml`、`application-sit.yml` 或其他 profile。
- 客户端升级不会覆盖已有配置、SQLite 数据、上传文件和日志。

内置后端以该目录作为工作目录，并通过 `spring.config.additional-location` 加载外置配置。默认 SQLite 位于 `data`，本地上传文件位于 `uploads`，日志位于 `logs`。修改配置后重启客户端即可重新启动后端并生效。若后端启动失败，客户端仍会打开，并直接显示真实启动错误和 `backend-console.log` 路径。

## SSH HTTP 接口对接

连接管理已对接 `SshConnectionController` 的列表、详情、新增、更新、删除、连接与断开 7 个接口。远程终端已接入真实 SSH，Agent 对话调用后端接口；本地终端和 SFTP 仍为模拟功能。

按需将 `.env.example` 复制为 `.env.local`；以下是构建时选项，修改后需重启 Vite 或重新构建：

- `VITE_SSH_USER_ID`：默认 `default`，列表与新增使用同一个用户 ID，避免后端两个默认用户值不一致。此值不是登录认证。

新增、更新提交 JSON；其他单连接操作通过 query 参数传 `connectionId`，成功码严格使用 `SUCCESS_0000`。连接成功后才打开终端；关闭远程终端标签时显示断开确认框，确认后先调用断开接口，成功才关闭标签；失败保留终端供重试。本地标签直接关闭。删除前先断开 SSH，因为后端删除接口不释放会话。

密码和完整私钥内容只随保存请求提交，不持久化到浏览器。编辑留空保留原凭据；更换认证方式需输入对应凭据。高级配置未在详情响应中返回，因此不伪造回显，未修改的字段不提交。环境和收藏是按用户与连接 ID 保存的本地偏好。

验证：`npm run build`；启动 Vite 后运行 `node scripts/verify-ssh.cjs`（需 Playwright 和 Chrome，可通过 `PLAYWRIGHT_MODULE_PATH` 指定 Playwright 模块）。测试拦截 HTTP 请求验证接口契约和界面流程，不访问真实 SSH 主机。

后端当前在更新时保留空凭据，并优先使用已存私钥建立连接，因此已有私钥连接不能直接切换为密码认证；前端会提示新建密码连接，避免显示切换成功却仍使用旧私钥。

断开弹框默认关闭同主机的关联标签并保留本机连接记录；取消勾选关联会话时，仅关闭所点标签，其余关联标签保留为离线。取消、稍后处理、Esc 和右上角关闭均不触发断开，请求期间禁止重复提交或关闭弹框。连接记录仅包含主机、地址和断开时间（最多 50 条），可在设置中查看，不保存终端内容或凭据。

断开确认流程测试：启动 Vite 后运行 `node scripts/verify-disconnect.cjs`（同样需要 Playwright 和 Chrome）。覆盖取消、稍后处理、Esc、非当前标签关闭、失败重试、请求期间锁定和连接记录选项。


## SSH 交互式终端

`SshTerminalController` 的 7 个接口已接入，地址为“客户端设置的后端根地址 + `/api/v1/ssh/terminal`”。

- `open`：SSH 连接成功后打开会话，使用后端返回的 `sessionId`，立即呈现 `initialOutput`。
- `exec`：常用命令的“运行”和日志操作提交真实命令，并补上 `\r`，因为服务按原始字节写入。
- `read`：每次请求完成后间隔 250ms 继续读取，支持延迟输出、长时间日志输出；与 exec 串行，避免同时读取并清空同一缓冲区。错误后暂停，手动重试读取，不重放命令。
- `write`：xterm 区域始终支持按键、粘贴、Tab、方向键等直接发往远端；点击常用命令正文可将内容写入当前终端。“中断 Ctrl+C”始终可用。
- `resize`：根据终端区域实际大小同步 cols / rows，文件面板、窗口尺寸和专注模式变化均会适配。
- `close`：关闭标签或在连接管理断开、删除主机时，先关闭 shell 再断开 SSH。关闭失败保留标签并提示重试。切换标签或导航不重新打开 shell。

远程输出由 xterm.js 渲染 ANSI 控制序列，不作为 HTML 插入。当前后端没有进程退出码或命令结束事件，前端“提交中”只代表请求状态；API 返回不代表远程命令已结束。`read` 消费缓冲区，网络中断时无法保证重传已读取的输出。

后端创建 PTY 时声明 `xterm-256color`，使 Vim、less、top 等全屏程序使用备用屏幕缓冲区；程序退出后 xterm.js 会恢复进入程序前的终端历史，避免 Vim 的 `~` 填充行残留或覆盖历史。

验证：启动 Vite 后运行 `node scripts/verify-terminal.cjs`。使用 Playwright / Chrome 和拦截的 HTTP 响应，覆盖 7 个接口、初始及延迟输出、回车、按键、尺寸、切换标签、错误重试和先关闭终端再断开连接的顺序。

## 客户端磁盘缓存

桌面客户端在可执行文件所在目录创建 `.cache`：聊天历史按会话写入 `.cache/chat`，用户添加的常用命令写入 `.cache/command/commands.json`。`npm run tauri dev` 无法解析可执行文件目录时回退到当前项目目录的 `.cache`；纯 `npm run dev` 没有 Tauri 文件接口，因此回退到浏览器 localStorage。命令分类由已保存的命令动态生成，添加命令时可以选择已有分类或直接输入新分类。
