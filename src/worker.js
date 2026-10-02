/**
 * abot-gateway v1 — MCP 统一网关
 *
 * 对外：mcp.abot.run，Bearer token 鉴权（GATEWAY_TOKEN）
 * 对内：按路径路由到各后端，带 X-Internal-Token
 *
 * 路由：
 *   /data/*    → abot-data
 *   /mail/*    → abot-mail
 *   /health/*  → abot-health
 *   /rules/*   → abot-rules
 *   /secrets/* → abot-secrets
 */

const ROUTES = {
  "/data/": { host: "https://data.abot.run", token_env: "INTERNAL_DATA" },
  "/mail/": { host: "https://mail.abot.run", token_env: "INTERNAL_MAIL" },
  "/health/": { host: "https://abot-health.boliam.workers.dev", token_env: "INTERNAL_HEALTH" },
  "/rules/": { host: "https://abot-rules.boliam.workers.dev", token_env: "INTERNAL_RULES" },
  "/secrets/": { host: "https://secrets.abot.run", token_env: "INTERNAL_SECRETS" },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查（免认证）
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "abot-gateway" });
    }

    // 对外鉴权
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.GATEWAY_TOKEN || token !== env.GATEWAY_TOKEN) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // 路由匹配
    let route = null;
    let prefix = "";
    for (const [p, r] of Object.entries(ROUTES)) {
      if (url.pathname.startsWith(p)) {
        route = r;
        prefix = p;
        break;
      }
    }
    if (!route) {
      return Response.json({ error: "unknown service, use /data/, /mail/, /health/, /rules/, /secrets/" }, { status: 404 });
    }

    // 解析目标 host（均为 workers.dev 或自有域名内部直连）
    const targetHost = route.host;

    // 内部 token
    const internalToken = env[route.token_env];
    if (!internalToken) {
      return Response.json({ error: "internal auth not configured for " + prefix }, { status: 502 });
    }

    // 透传：去掉前缀，拼目标 URL
    const rest = url.pathname.slice(prefix.length);
    const targetUrl = targetHost + "/" + rest + url.search;

    const headers = new Headers(request.headers);
    headers.set("X-Internal-Token", internalToken);
    // 保留原始 Authorization（后端用它做用户身份识别）

    const resp = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer(),
    });

    // 透传响应；如果是 MCP initialize，改写 serverInfo.name 标明服务
    const respHeaders = new Headers(resp.headers);
    const contentType = resp.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const text = await resp.text();
      try {
        const body = JSON.parse(text);
        if (body.result && body.result.serverInfo && body.result.serverInfo.name) {
          const origName = body.result.serverInfo.name;
          const svc = prefix.replace(/^\//, "").replace(/\/$/, "");
          body.result.serverInfo.name = `abot-gateway/${svc} (${origName})`;
          return new Response(JSON.stringify(body), {
            status: resp.status, headers: respHeaders,
          });
        }
      } catch {
        // 不是合法 JSON，直接透传原文
      }
      return new Response(text, { status: resp.status, headers: respHeaders });
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: respHeaders,
    });
  },
};
