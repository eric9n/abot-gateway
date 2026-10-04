# 本地 Service Binding e2e

这个脚本用 `wrangler dev` 在本机拉起网关和 6 个 mock 后端，不部署、不访问 Cloudflare。

```bash
npm run e2e
```

Mock 的 Worker 名与线上一致（`abot-data`、`resend-agent-mail-relay`、`abot-health`、`abot-rules`、`abot-secrets`、`abot-sms`），脚本是 `e2e/mock-backend.js`。本地 D1 里会插入一个夹具身份 `e2e-agent@abot.run` / `ask_e2e_local_only`，用来走授权码换 token。这不是线上账号。

## 需要人工在 Cloudflare 上验证

本环境没有 Cloudflare 凭证，下面几步这里做不了：

1. 把网关部署到 staging。根目录 `wrangler.toml` 是生产配置（生产路由和 D1），不要拿来部署 staging；合并到 `main` 会走 CI 部署到生产。
2. 在线上网关的配置里加上同样的 6 个 service binding，指向**已经部署的真实 Worker**，并保留现有 D1 `DB`。名字见根目录 `wrangler.toml`。本地 mock 不能代替这一步。
3. 确认 6 个真实后端接受 Service Binding 请求，并且不再强制校验 `X-Internal-Token`。后端如果还在验 token，staging 上的转发会失败，即使本地 e2e 是通过的。
4. 用 Cloudflare Access 打开 `https://admin.abot.run`，走真实的邀请码审核拿到 agent secret。本地脚本是直接往本地 D1 插了一行 `agent_tokens`，绕过了 Access。
5. 用这个真实 secret 对 staging 再走一遍：注册 OAuth client、授权码换 token，然后请求 `/data/`、`/mail/`、`/health/`、`/rules/`、`/secrets/`、`/sms/`，核对后端收到的路径和 `X-Abot-Owner-Email`。
6. 不要对生产后端做 500 注入。`/__e2e_fail` 只存在于本地 mock。线上要验证「5xx 变成通用 502 且不泄漏地址」，需要单独的 staging 后端，或只采信这次本地结果。
