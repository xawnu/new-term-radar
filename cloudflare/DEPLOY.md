# 部署 new-term-radar 到 Cloudflare（radar.9180.net）

这份文档给执行部署的人（或 Codex）用，自包含。目标是把仓库里的 Python 雷达跑在 Cloudflare Containers 上，由 Cron Trigger 定时触发，域名 `radar.9180.net`。

## 背景

- 项目是纯 Python 标准库的 CLI，入口 `python -m radar {daily|sources}`。状态存在一个 SQLite 文件和快照目录里。
- 部署方式：一个 Worker 负责定时触发和读写 R2 上的状态；一个容器（镜像由仓库根目录的 `Dockerfile` 构建）里运行 `cloudflare/server.py`，它接收命令、解包状态、调用 `python -m radar`、把新状态和报告返回给 Worker。
- 定时：仅 `30 1 * * *` 跑完整 `daily`（UTC），即北京时间每天 09:30 一次，包含 X 和 Hugging Face。
- 费用预期：Workers Paid（$5/月）加上很小的容器用量，容器在空闲 10 分钟后休眠。

## 文件清单（已存在，不要改动除非遇到报错）

| 路径 | 作用 |
|---|---|
| `Dockerfile`（仓库根） | `python:3.12-slim`，安装 `requirements.txt`，拷入 `radar/`、`config.json`、`cloudflare/server.py` |
| `cloudflare/server.py` | 容器内的 HTTP 服务，`POST /run?cmd=daily|sources`，监听 8080 |
| `cloudflare/src/index.js` | Worker 入口：`scheduled`（cron）、`fetch`（`/health`、`/report`） |
| `cloudflare/wrangler.toml` | Worker 配置：域名路由、cron、R2 绑定 `STATE`、容器 `basic` 规格、Durable Object |
| `cloudflare/package.json` | 依赖 `@cloudflare/containers@^0.3.7`，开发依赖 `wrangler@^4` |
| `config.example.json`（仓库根） | 模板。`config.json` 不在 git 里，需要从它复制 |

## 前置条件

1. macOS，已安装并启动 Docker Desktop（`docker info` 能正常返回）。
2. Node.js 18 或更高版本，`npm -v` 可用。
3. 一个 Cloudflare 账号，已有 Workers Paid 订阅（容器需要）。
4. `9180.net` 这个域名已经托管在该账号的 DNS 里（否则 `radar.9180.net` 的路由会失败）。
5. 有以下 API 密钥（至少 AIsa）：`AISA_API_KEY`。可选：`GOANYAPI_API_KEY`、`GITHUB_TOKEN`、`RESEND_API_KEY`、`EMAIL_FROM`、`RADAR_EMAIL_TO`、`GSC_TOKEN_JSON`。

## 步骤

以下命令在仓库根目录 `new-term-radar/` 下执行，除非另有说明。

### 1. 检查 Docker 和 Cloudflare 登录

```
docker info > /dev/null && echo "docker ok"
cd cloudflare && npm install
npx wrangler whoami
```

如果 `whoami` 显示未登录，执行 `npx wrangler login`，它会打开浏览器让人工授权。这一步必须由人完成，不要试图替代它。

### 2. 准备配置文件

```
cp config.example.json config.json
```

`config.json` 里的 X 账号、sitemap、主题等由用户决定。如果用户没有给出具体内容，就保留示例默认值，并在最终报告里说明这一点。不要把任何密钥写进 `config.json`。

### 3. 创建 R2 存储桶

```
cd cloudflare
npx wrangler r2 bucket create new-term-radar-state
```

如果提示已存在，忽略即可，继续下一步。

### 4. 添加密钥

密钥只能通过交互式的 `wrangler secret put` 输入，不要在命令行参数、代码或聊天里出现明文：

```
npx wrangler secret put AISA_API_KEY
npx wrangler secret put VIEW_TOKEN
```

`VIEW_TOKEN` 是随机字符串，用于保护 `/report`。如果用户没有提供，就生成一个（例如 `openssl rand -hex 24`），并把它交给用户保存，不要写入任何文件或日志。

可选密钥按需同样方式添加。

### 5. 部署

```
npx wrangler deploy
```

首次部署会构建 Docker 镜像，可能需要几分钟。如果报错，先看完整输出，不要盲目重试。常见原因：

- 构建失败：通常是 `config.json` 不存在（步骤 2 没做）或 Docker 没启动。
- 路由失败（域名相关）：`9180.net` 不在该账号下，需要用户在 Cloudflare 控制台确认 DNS。
- R2 绑定失败：确认步骤 3 的桶名与 `wrangler.toml` 里的 `bucket_name` 一致。
- 容器相关的 API 报错：检查 `@cloudflare/containers` 版本是否为 `^0.3.7`，并把完整报错交给用户。

### 6. 验证

```
curl -sS https://radar.9180.net/health
```

应返回 `ok`。

```
curl -sS -o /dev/null -w "%{http_code}\n" https://radar.9180.net/report
```

没有带 token 时应返回 `401`。

带 token 测试（token 不要打印到日志）：

```
curl -sS -H "Authorization: Bearer $VIEW_TOKEN" https://radar.9180.net/report
```

第一次运行前可能没有报告，返回 `404 no report yet` 是正常的。

### 7. 触发一次测试运行（可选）

本地模拟 cron：

```
npx wrangler dev --test-scheduled
```

另开一个终端访问：

```
curl "http://localhost:8787/__scheduled?cron=0+0%2C8%2C16+*+*+*"
```

这会触发 `sources`。成功后 `radar.9180.net/report` 通常会在有新名字时才有内容。`daily` 用 `cron=30+1+*+*+*` 触发。

## 验收标准

- `curl https://radar.9180.net/health` 返回 `ok`。
- `wrangler deploy` 成功，输出里有 `radar.9180.net` 路由。
- 密钥已通过 `wrangler secret put` 写入，`wrangler secret list` 能列出名字（不显示值）。
- R2 桶 `new-term-radar-state` 存在。
- 完成一次 `__scheduled` 测试后，R2 里出现 `state.tgz`。

## 已知限制（请如实告诉用户）

- 这套 Worker 和容器的代码是在沙箱里验证过容器服务的 HTTP 流程（`sources` 返回 exit 0，状态能往返），但**没有在真实 Cloudflare 上部署过**，`wrangler.toml` 的 `image = "../Dockerfile"` 相对路径、Docker 镜像构建、R2 绑定，都未实测。
- X 信号需要 AIsa key 才有数据，没有 key 时该信号会报错但不影响其他信号。
- 容器闲置 10 分钟会休眠，首次请求会有冷启动延迟，这是预期行为。

## 安全注意

- 不要把任何 API 密钥、token 或 OAuth 回调链接（含 `code=` 的 URL）粘贴到聊天、日志或提交到 git。
- `config.json`、`.env`、`cloudflare/.wrangler/`（wrangler 的本地缓存）和 `cloudflare/node_modules/` 已被 `.gitignore` 排除。
- 如果 `wrangler login` 授权的范围过大，部署完成后可以在 Cloudflare 后台撤销这次授权。
