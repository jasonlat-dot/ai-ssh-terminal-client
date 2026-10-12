# 客户端发布后，自动更新 ShellPilot 官网

配置一次即可。工作流已经准备在 `.github/workflows/deploy-website.yml`，当前还需要创建 Cloudflare Deploy Hook、保存 GitHub Secret，并把工作流提交推送到客户端仓库，才能生效。

正常流程：发布客户端正式 Release → GitHub Actions 检查 Latest 和发布附件 → 请求 Cloudflare Hook → 官网重新构建并同步版本、下载链接。

官网项目仍是 Cloudflare Pages 的 `shellpilot`，域名 `shellpilot.jasonlat.cc`；客户端发布仓库是 `jasonlat-dot/ai-ssh-terminal-client`。工作流放在**客户端仓库**，Hook 指向**官网 Pages 项目**。

## 1. 在 Cloudflare 创建 Hook

1. 进入 Workers & Pages，打开 Pages 项目 `shellpilot`。
2. 打开 **Settings → Builds**，找到 **Deploy hooks**，点击 **Add deploy hook**。
3. 名称填写 `client-release`，构建分支选择 `main`。
4. 保存并复制生成的 Hook URL，下一步将它填进 GitHub Secret。

这是通知官网重新构建的专用链接，无需另外申请 Cloudflare API Token。链接保存在 GitHub Secret，不放进代码或教程。

官方说明：[Cloudflare Deploy Hooks](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)。

## 2. 在客户端 GitHub 仓库保存 Secret

打开 GitHub 仓库 **jasonlat-dot/ai-ssh-terminal-client**，不是官网的 ShellPilot 仓库：

1. **Settings → Secrets and variables → Actions**。
2. 点击 **New repository secret**。
3. Name 填写 `SHELLPILOT_PAGES_DEPLOY_HOOK`。
4. Secret 填写上一步复制的完整 Hook URL。
5. 点击 **Add secret**。

名字必须与工作流一致。工作流只从 Secret 读取真实链接；文件中没有链接、令牌或发布签名私钥。

官方说明：[GitHub Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

## 3. 提交工作流，首次手动测试

在客户端仓库根目录的 PowerShell 终端执行：

```powershell
git add .github/workflows/deploy-website.yml docs/website-auto-deploy.md README.md
git commit -m "ci: refresh website after client release"
git push origin main
```

效果：让 GitHub 获得工作流；仅本地创建文件不会使 GitHub Actions 生效。提交前确认 README 没有夹带其他不相关修改，也可以在 IDE 中只选择这次的教程链接。

最好在创建 `v0.1.11` 标签及 Release 之前推送工作流。已有标签/旧版已经发布时，可以先手动触发一次：

1. 打开客户端仓库 **Actions**。
2. 左侧选择 **Update ShellPilot website**。
3. 点击 **Run workflow**，选择 `main`，再点击运行。
4. 工作流检查当前 Latest 的正式版本及附件，向 Cloudflare 发送一次构建请求。
5. 在 Cloudflare Pages 的 **Deployments** 确认新构建成功，再访问官网确认版本及下载按钮。

Actions 成功意味着构建通知已发出，不代表 Cloudflare 已完成部署。官网构建若无法读取 GitHub，会保留旧版本并在构建日志中警告；此时检查 Cloudflare 构建日志。

## 4. 发布 0.1.11 及以后版本

现有 `npm run release:windows` 只在本地生成发布文件，不负责上传 GitHub；官网更新在 GitHub 正式 Release 发布后触发。

建议在 GitHub 先创建草稿 Release，上传完成后再发布。以 v0.1.11 为例：

- 标签为 `v0.1.11`，使用已经包含工作流的客户端提交。
- 上传 `ShellPilot_0.1.11_x64-setup.exe`、对应 `.exe.sig`、`latest.json`，以及你需要提供的发布说明/校验文件。
- 发布为正式版本，设置为 **Latest**。
- 点击 **Publish release**，GitHub Actions 随后自动运行。

后续版本沿用这个流程，无需每次手动修改官网版本或重跑 Pages。工作流也兼容旧前缀 `ai-ssh-terminal-client_版本_x64-setup.exe`。

## 5. 遇到失败怎么处理

| 提示 | 处理方法 |
| --- | --- |
| Secret 未配置 | 在客户端仓库添加准确名称的 Secret，手动运行工作流 |
| 本次发布未设为 Latest | 将版本设为 Latest，然后手动运行工作流 |
| 缺少安装包、签名或 latest.json | 补齐该 Release 的附件，然后手动运行工作流 |
| Hook 请求失败 | 检查 Secret 中的 URL 是否完整、Hook 是否仍存在，再重跑 |
| Actions 成功但官网还是旧版本 | 查看 Cloudflare 构建/部署结果及版本同步警告；确认 latest.json 对应正式版本 |

草稿不触发；预发布会跳过。仅编辑发布说明、补传附件或只推送代码，不会重新触发 `release.published`，需要在 Actions 使用 **Run workflow**。后续如果改成用另一条工作流自动创建 Release，GitHub 对 `GITHUB_TOKEN` 触发后续工作流有规则，需要在发布完成的工作流内直接请求 Hook 或调整认证方式。

本地已验证 YAML 结构、Bash 语法和 9 个模拟场景，包括正式版、手动重跑、旧包名前缀、Secret 缺失、附件缺失、非 Latest 和无效版本等；失败场景没有发出部署通知。没有真实 Hook/Secret 时，尚不能验证 GitHub → Cloudflare 的实际部署链路。

官方说明：[GitHub Release 触发事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)。
