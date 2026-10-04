# aBot Gateway

统一 MCP 网关，聚合 mail/data/health/rules/secrets/sms 六个后端服务。

## 开发

```bash
npm test          # 跑测试
npm run build     # 构建 dist/worker.js
npm run e2e       # 本地 wrangler dev + mock 后端。不是 Cloudflare 部署，人工步骤见 e2e/README.md
```

## 部署

push 到 main 自动部署（需配置 GitHub Secrets）：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

CI 先 `node build.js` 生成 `dist/worker.js`（把 `src/admin.js` 嵌进 admin 页），再用根目录 `wrangler.toml` 执行 `wrangler deploy`。`wrangler.toml` 与线上 Worker 的配置一致：入口 `dist/worker.js`、D1 binding `DB`（`abot-data`）、下面 6 个 service binding、路由 `admin.abot.run/*` 和 `abot.run/*`、`workers_dev = false`。改线上配置时同步改这个文件，否则下次部署会覆盖回去。不要直接部署未构建的 `src/worker.js`。

网关用 Cloudflare Service Bindings 调用后端：`env.<BINDING>.fetch()`，不走公网，也不再读取或转发 `X-Internal-Token`。身份仍通过 `X-Abot-Owner-Email` 传递。网关和这 6 个后端必须在同一个 Cloudflare 账号，`service` 是 Worker 脚本名。

| 路径前缀 | Binding | 后端 Worker |
| --- | --- | --- |
| `/data/` | `BACKEND_DATA` | `abot-data` |
| `/mail/` | `BACKEND_MAIL` | `resend-agent-mail-relay` |
| `/health/` | `BACKEND_HEALTH` | `abot-health` |
| `/rules/` | `BACKEND_RULES` | `abot-rules` |
| `/secrets/` | `BACKEND_SECRETS` | `abot-secrets` |
| `/sms/` | `BACKEND_SMS` | `abot-sms` |

Binding 未配置时返回 `502`，并带上缺少哪个 binding。后端抛错或返回 5xx 时返回 `502 {"error":"backend_unavailable","service":"<名>"}`，不透传后端原文。

网关不再使用 `INTERNAL_DATA` / `INTERNAL_MAIL` / `INTERNAL_HEALTH` / `INTERNAL_RULES` / `INTERNAL_SECRETS`。后端改为信任 Service Binding 之后，这些 secret 可以删掉。本仓库不包含后端，合并本改动前需要后端不再强制校验内部 token，否则内部调用会失败。

## 管理页

`https://admin.abot.run/`（只在这个域名提供，`abot.run/admin` 返回 404）。Cloudflare Access 应用 `aBot Admin` 在边缘拦截，Worker 内再校验 `Cf-Access-Jwt-Assertion`（RS256、AUD tag、iss、exp/nbf）。管理接口 `POST /invite|/approve|/deny|/rotate|/revoke` 只接受 `Content-Type: application/json` 且 `Origin: https://admin.abot.run` 的请求。吊销后申请变为 `revoked`，旧 secret、OAuth token 和授权码全部失效；已分配过的邮箱不会再分配给别的申请。

`POST /provision/request`（mail.abot.run 通过 service binding 转发 `/signup`）不受上述限制。

## 安装 skills

仓库在 Cursor Origin，不在 GitHub。Origin 没有免认证 raw 文件，不能 `curl | bash`。需要 git，并且当前环境能克隆该仓库（例如已经 `origin auth login`）：

```bash
git clone --depth 1 https://origin.cursor.com/git/dagow/abot-gateway.git
bash abot-gateway/install-skills.sh
```

已经有这份脚本时直接 `./install-skills.sh`。脚本用 sparse-checkout 只拉 `skills/abot`，装到 `~/.muse/skills/abot/`。没有 git 时脚本会退出并说明原因。

`skills/abot/references/` 在仓库里手写维护，不自动生成。

## 结构

- `src/worker.js`：网关主逻辑（含 `/*__ADMIN_JS__*/` 占位符，构建时替换成 admin.js）
- `src/admin.js`：Admin 页面前端 JS（构建时嵌入）
- `test/basic.js`：测试入口（静态检查 + 用 `node:sqlite` 模拟 D1 的行为测试，需要 Node 22+）
- `test/harness.js`：D1 模拟、自签 Access JWT
- `build.js`：构建脚本
- `wrangler.toml`：线上部署配置（CI 使用）
- `skills/abot/`：给 agent 的 skill 包（`SKILL.md`、`bin/abot-mcp`、`references/`）
- `install-skills.sh`：把 `skills/abot` 装到 `~/.muse/skills/abot/`
