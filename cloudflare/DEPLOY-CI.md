# 通过 GitHub Actions 部署到 Cloudflare（radar.9180.net）

这份文档是给执行者（Claude Code 或其他智能体）用的，按顺序执行即可。
目标：把 Fork 仓库 `xawnu/new-term-radar` 推送后，由 GitHub Actions 在远端构建 Docker 镜像，并部署 Worker、R2 桶、密钥和容器到 Cloudflare，域名 `radar.9180.net`。
本机不需要安装 Docker，也不需要 wrangler。

这份文档取代 `cloudflare/DEPLOY.md` 中的"本地部署"路径。`DEPLOY.md` 仍然保留，作为本地备用方案。

## 0. 前提与需要人工完成的部分

执行者无法代替用户完成以下步骤，遇到时请停下来请用户操作：

1. **Cloudflare 账号**：已有 Workers Paid 订阅；`9180.net` 已托管在该账号的 DNS 下。
2. **Cloudflare API token**：用户在控制台 My Profile → API Tokens → Create Token 创建，模板选 "Edit Cloudflare Workers"，并追加 R2 Storage 的编辑权限。token 只能由用户创建和保存，执行者不能要求用户把它贴到聊天里。
3. **Cloudflare Account ID**：在控制台右侧栏可以看到，是一串 32 位十六进制字符。
4. **AIsa API key**（`AISA_API_KEY`）：由用户提供。
5. **VIEW_TOKEN**：用户自定义的随机字符串，用来保护 `/report`。如果用户没有指定，执行者可以生成一个（例如 `openssl rand -hex 24`），但要把它交给用户保存，不能写进任何文件或日志。
6. **GitHub 登录**：执行者需要能对用户的 GitHub 账号执行 `git push` 和 `gh secret set`。如果尚未登录，请用户运行 `gh auth login`。

## 1. 准备本地仓库

```bash
git clone https://github.com/xawnu/new-term-radar ~/new-term-radar-deploy
cd ~/new-term-radar-deploy
```

如果目录已存在，先确认它是这个 Fork 的克隆，并执行 `git pull --ff-only`。

## 2. 同步部署文件

从项目源目录（当前工作目录里的 `new-term-radar` 文件夹）把以下文件复制到克隆目录，覆盖同名文件：

- `Dockerfile`
- `cloudflare/`（整个文件夹，包括 `server.py`、`src/index.js`、`wrangler.toml`、`package.json`、`DEPLOY.md`、`DEPLOY-CI.md`）
- `.github/workflows/deploy-cloudflare.yml`

不要复制 `.git` 文件夹（源目录里的那个是损坏的）。

```bash
SRC="/Volumes/新加卷/xawnu/aiweb/radar.9180.net/new-term-radar"
DST="$HOME/new-term-radar-deploy"
cp "$SRC/Dockerfile" "$DST/"
cp -R "$SRC/cloudflare" "$DST/"
mkdir -p "$DST/.github/workflows"
cp "$SRC/.github/workflows/deploy-cloudflare.yml" "$DST/.github/workflows/"
```

## 3. 准备配置并允许提交

```bash
cd "$DST"
cp config.example.json config.json   # 如果 config.json 已存在，保留它，不要覆盖
```

`config.json` 里的 X 账号、sitemap、主题由用户决定。如果用户没有指定，保留示例默认值即可，并在最终报告里说明。

`config.json` 默认在 `.gitignore` 里。删除 `.gitignore` 中的 `config.json` 那一行，否则 Dockerfile 无法在 runner 上拿到它，workflow 的第一步检查会失败。

## 4. 提交并推送

```bash
cd "$DST"
git add -A
git status --short          # 确认只包含上面列出的文件和 config.json，没有 .wrangler/、node_modules/、.env 或任何密钥
git commit -m "Add Cloudflare deploy via GitHub Actions"
git push origin main
```

如果 `git status` 显示 `cloudflare/.wrangler/` 或 `cloudflare/node_modules/`，把它们加入 `.gitignore` 后再提交，不要提交它们。

## 5. 设置 GitHub 仓库 secrets

优先用 `gh` 设置。不要把 secret 值打印到终端或日志里。值由用户提供，执行者通过管道传入：

```bash
cd "$DST"
gh secret set CLOUDFLARE_ACCOUNT_ID          # 交互式输入，或由用户粘贴到另一个终端
gh secret set CLOUDFLARE_API_TOKEN
gh secret set AISA_API_KEY
gh secret set VIEW_TOKEN
```

可选的 secret：`GOANYAPI_API_KEY`、`RESEND_API_KEY`、`EMAIL_FROM`、`RADAR_EMAIL_TO`、`GSC_TOKEN_JSON`。用户没有提供就跳过，workflow 会自动跳过未设置的项。

如果 `gh` 不可用，让用户到 GitHub 网页的 Settings → Secrets and variables → Actions 里手动添加。

检查是否都已设置（只列名字，不显示值）：

```bash
gh secret list
```

## 6. 触发并观察部署

推送后 workflow 会自动运行（`push` 到 `main` 且改动了相关路径）。也可以手动触发：

```bash
gh workflow run deploy-cloudflare.yml
gh run watch
```

workflow 包括这些步骤：检查 `config.json` 已提交 → 安装 Node 22 和 npm 依赖 → 创建 R2 桶（已存在则跳过）→ 设置已提供的 secrets → `npx wrangler deploy`（在 runner 上构建 Docker 镜像）→ 健康检查 `https://radar.9180.net/health`。

## 7. 验证

```bash
curl -sS https://radar.9180.net/health                       # 应返回 ok
curl -sS -o /dev/null -w "%{http_code}\n" https://radar.9180.net/report   # 应返回 401
curl -sS -H "Authorization: Bearer <VIEW_TOKEN>" https://radar.9180.net/report   # 第一次可能是 404 no report yet，属正常
```

`<VIEW_TOKEN>` 由用户提供，执行者不要把它写进任何文件或日志。

## 8. 常见失败与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| "config.json is missing from the repository" | 没提交 `config.json` 或仍被 `.gitignore` 忽略 | 执行第 3 步，删除 `.gitignore` 中的 `config.json` 行，重新提交 |
| `wrangler deploy` 报 Docker 或镜像构建错误 | Dockerfile 或 requirements 有问题 | 看 Actions 日志里的 Docker 输出，修复后重新推送 |
| 权限不足（403 / Authentication error） | API token 权限不够 | 请用户在控制台给 token 补充 Workers Scripts、Workers R2 Storage 等编辑权限，然后重新设置 `CLOUDFLARE_API_TOKEN` |
| `route` 或 DNS 相关错误 | `9180.net` 未在该账号下托管 | 请用户在 Cloudflare 控制台确认域名 |
| 健康检查失败（`/health` 无响应） | 部署已完成，但路由或容器未就绪 | 等待 1 到 2 分钟再试；仍失败则查看 Cloudflare 控制台的 Worker 日志 |
| `wrangler secret put` 相关错误 | 通过管道传入值的方式在当前 wrangler 版本不兼容 | 报告给用户，改为请用户在 Cloudflare 控制台 Settings → Variables and Secrets 手动添加 |

注意：镜像构建、推送和上线不是原子操作。如果在构建后失败，Worker 可能已经更新。遇到失败时，先看 Actions 日志确认是哪一步出的错，再决定是否重试，不要盲目重复部署。

## 9. 交付报告

### 报告阅读页面

部署后打开 `https://radar.9180.net/`，输入自行保存的 `VIEW_TOKEN` 查看报告。密码仅保存在当前页面内存，不写入浏览器存储；刷新或关闭页面后需要重新输入。

报告按北京时间日期保存到 R2 的 `reports/YYYY-MM-DD/daily-1.md`、`daily-2.md` 或 `sources-1.md` 等。同一天同类型按数字递增，每次新增归档；写入使用 R2 的条件创建，已有批次不会覆盖。页面显示日期加批次号，例如 `2026-10-13-1`。来源任务没有新报告时不会创建空归档。`report.md` 继续用于原有最新报告接口。

网页提供日期选择、日报与来源更新切换、Markdown 下载。部署 workflow 验证页面、未登录保护和已有归档读取。手动运行使用 `run-cloudflare.yml`，仅执行一次完整 daily（包含 X、Hugging Face）。生产定时任务每天北京时间 09:30 执行一次；不再单独定时运行 sources，独立 Python workflow 仅保留手动触发。

执行完成后，向用户报告：

- Actions 运行链接和最终状态（成功或失败，附关键日志）
- `curl https://radar.9180.net/health` 的结果
- 已设置的 secret 名字列表（不含值）
- 未完成的步骤和原因（如果有）

## 安全要求

- 不把任何 token、API key、VIEW_TOKEN、OAuth 回调链接（含 `code=` 的 URL）写入仓库、日志、聊天或提交信息。
- 不把 `.env`、`gsc_token.json`、`gsc_client.json` 提交到仓库。
- 完成后，如果 `wrangler login` 或 `gh auth` 授权范围过大，提醒用户之后可以在对应平台撤销。
