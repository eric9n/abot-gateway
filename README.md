# abot-gateway

MCP 统一网关：对外鉴权 + 按路径路由到各后端。

- 对外：`mcp.abot.run`（或 `api.abot.run`，待定），Bearer token（GATEWAY_TOKEN）
- 对内：X-Internal-Token，各后端独立 token

路由：
- `/data/*` → abot-data
- `/mail/*` → abot-mail
- `/health/*` → abot-health
- `/rules/*` → abot-rules
- `/secrets/*` → abot-secrets
