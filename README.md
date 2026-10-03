# aBot Gateway

统一 MCP 网关，聚合 mail/data/health/rules/secrets 五个后端服务。

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

网关用 Cloudflare Service Bindings 调用后端：`env.<BINDING>.fetch()`，不走公网，也不再读取或转发 `X-Internal-Token`。身份仍通过 `X-Abot-Owner-Email` 传递。

部署前把下面 5 个 service binding 加进**现有** wrangler 配置（或 Dashboard → Worker → Bindings）。网关和这 5 个后端必须在同一个 Cloudflare 账号。`service` 是 Worker 脚本名。请与现有的 D1 binding `DB`、路由一起保留，不要用残缺配置覆盖线上 Worker。可复制的片段见 `wrangler.toml.example`（该文件不会被 CI 部署；CI 仍使用 `wrangler.toml`）。

| 路径前缀 | Binding | 后端 Worker |
| --- | --- | --- |
| `/data/` | `BACKEND_DATA` | `abot-data` |
| `/mail/` | `BACKEND_MAIL` | `resend-agent-mail-relay` |
| `/health/` | `BACKEND_HEALTH` | `abot-health` |
| `/rules/` | `BACKEND_RULES` | `abot-rules` |
| `/secrets/` | `BACKEND_SECRETS` | `abot-secrets` |

Binding 未配置时返回 `502`，并带上缺少哪个 binding。后端抛错或返回 5xx 时返回 `502 {"error":"backend_unavailable","service":"<名>"}`，不透传后端原文。

网关不再使用 `INTERNAL_DATA` / `INTERNAL_MAIL` / `INTERNAL_HEALTH` / `INTERNAL_RULES` / `INTERNAL_SECRETS`。后端改为信任 Service Binding 之后，这些 secret 可以删掉。本仓库不包含后端，合并本改动前需要后端不再强制校验内部 token，否则内部调用会失败。

## 结构

- `src/worker.js`：网关主逻辑（含 `/*__ADMIN_JS__*/` 占位符）
- `src/admin.js`：Admin 页面前端 JS（构建时嵌入）
- `test/basic.js`：基础测试
- `build.js`：构建脚本
- `wrangler.toml.example`：需要合并进现有配置的 5 个 service bindings
