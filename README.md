# ai-ssh-terminal-client
ai-ssh-terminal-client


## SSH HTTP 接口对接

连接管理已对接 `SshConnectionController` 的列表、详情、新增、更新、删除、连接与断开 7 个接口。终端命令、SFTP 和 AI 仍为模拟功能。

将 `.env.example` 复制为 `.env.local` 后按需修改，重启 Vite 或重新构建生效：

- `VITE_SSH_API_BASE_URL`：完整控制器地址，默认 `http://localhost:8888/api/v1/ssh`，只包含一个 `/api/v1`。可在 `.env.local` 中覆盖。
- `VITE_SSH_USER_ID`：默认 `default`，列表与新增使用同一个用户 ID，避免后端两个默认用户值不一致。此值不是登录认证。

新增、更新提交 JSON；其他单连接操作通过 query 参数传 `connectionId`，成功码严格使用 `SUCCESS_0000`。连接成功后才打开终端；关闭远程终端标签时显示断开确认框，确认后先调用断开接口，成功才关闭标签；失败保留终端供重试。本地标签直接关闭。删除前先断开 SSH，因为后端删除接口不释放会话。

密码和完整私钥内容只随保存请求提交，不持久化到浏览器。编辑留空保留原凭据；更换认证方式需输入对应凭据。高级配置未在详情响应中返回，因此不伪造回显，未修改的字段不提交。环境和收藏是按用户与连接 ID 保存的本地偏好。

验证：`npm run build`；启动 Vite 后运行 `node scripts/verify-ssh.cjs`（需 Playwright 和 Chrome，可通过 `PLAYWRIGHT_MODULE_PATH` 指定 Playwright 模块）。测试拦截 HTTP 请求验证接口契约和界面流程，不访问真实 SSH 主机。

后端当前在更新时保留空凭据，并优先使用已存私钥建立连接，因此已有私钥连接不能直接切换为密码认证；前端会提示新建密码连接，避免显示切换成功却仍使用旧私钥。

断开弹框默认关闭同主机的关联标签并保留本机连接记录；取消勾选关联会话时，仅关闭所点标签，其余关联标签保留为离线。取消、稍后处理、Esc 和右上角关闭均不触发断开，请求期间禁止重复提交或关闭弹框。连接记录仅包含主机、地址和断开时间（最多 50 条），可在设置中查看，不保存终端内容或凭据。

断开确认流程测试：启动 Vite 后运行 `node scripts/verify-disconnect.cjs`（同样需要 Playwright 和 Chrome）。覆盖取消、稍后处理、Esc、非当前标签关闭、失败重试、请求期间锁定和连接记录选项。
