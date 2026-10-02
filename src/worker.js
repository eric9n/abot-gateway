/**
 * abot-gateway v2 — MCP 统一网关 + OAuth
 *
 * 对外：abot.run，OAuth 2.0（DCR）+ Bearer token 鉴权
 * 对内：按路径路由到各后端，带 X-Internal-Token
 *
 * 路由：
 *   /data/*    → abot-data
 *   /mail/*    → abot-mail
 *   /health/*  → abot-health
 *   /rules/*   → abot-rules
 *   /secrets/* → abot-secrets
 *
 * OAuth：
 *   /.well-known/oauth-authorization-server
 *   /oauth/register (DCR)
 *   /oauth/authorize (GET 显示授权页，POST 确认)
 *   /oauth/token (code 换 token)
 */

const ROUTES = {
  "/data/": { host: "https://data.abot.run", token_env: "INTERNAL_DATA" },
  "/mail/": { host: "https://mail.abot.run", token_env: "INTERNAL_MAIL" },
  "/health/": { host: "https://abot-health.boliam.workers.dev", token_env: "INTERNAL_HEALTH" },
  "/rules/": { host: "https://abot-rules.boliam.workers.dev", token_env: "INTERNAL_RULES" },
  "/secrets/": { host: "https://secrets.abot.run", token_env: "INTERNAL_SECRETS" },
};

function newId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function ensureOAuthTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`)?.run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_codes (
    code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    code_challenge TEXT, expires_at INTEGER NOT NULL)`)?.run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_tokens (
    token TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`)?.run();
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查（免认证）
    if (path === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "abot-gateway" });
    }

    // OAuth 元数据
    if (path === "/.well-known/oauth-authorization-server") {
      const base = url.origin;
      return Response.json({
        issuer: base,
        authorization_endpoint: base + "/oauth/authorize",
        token_endpoint: base + "/oauth/token",
        registration_endpoint: base + "/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    // DCR：动态客户端注册
    if (path === "/oauth/register" && request.method === "POST") {
      try {
        await ensureOAuthTables(env);
      } catch (e) {
        return Response.json({ error: "db_error", detail: String(e && e.message || e) }, { status: 500 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_request", detail: "body must be JSON" }, { status: 400 });
      }
      const redirectUris = body.redirect_uris || [];
      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
      }
      const clientId = newId("cli");
      await env.DB.prepare("INSERT INTO oauth_clients (client_id, redirect_uris) VALUES (?,?)")
        .bind(clientId, JSON.stringify(redirectUris)).run();
      return Response.json({ client_id: clientId, redirect_uris: redirectUris });
    }

    // 授权页
    if (path === "/oauth/authorize") {
      await ensureOAuthTables(env);
      const q = url.searchParams;
      const clientId = q.get("client_id") || "";
      const redirectUri = q.get("redirect_uri") || "";
      const state = q.get("state") || "";
      const codeChallenge = q.get("code_challenge") || "";

      // 验证 client
      const client = await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id=?")
        .bind(clientId).first();
      if (!client) {
        return new Response("invalid client_id", { status: 400 });
      }
      const allowedUris = JSON.parse(client.redirect_uris || "[]");
      if (!allowedUris.includes(redirectUri)) {
        return new Response("invalid redirect_uri", { status: 400 });
      }

      if (request.method === "GET") {
        // 显示授权确认页
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>aBot 授权</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:20px}
button{background:#0066ff;color:#fff;border:0;padding:12px 32px;font-size:16px;border-radius:8px;cursor:pointer}</style>
</head><body>
<h2>aBot 网关授权</h2>
<p>客户端 <code>${clientId}</code> 请求访问你的 aBot 服务（健康/邮件/数据/规则）。</p>
<form method="POST">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="redirect_uri" value="${redirectUri}">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="code_challenge" value="${codeChallenge}">
<button type="submit">允许访问</button>
</form></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const code = newId("code");
        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 分钟
        await env.DB.prepare(
          "INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at) VALUES (?,?,?,?,?)"
        ).bind(code, clientId, redirectUri, codeChallenge || null, expiresAt).run();
        const dest = new URL(redirectUri);
        dest.searchParams.set("code", code);
        if (state) dest.searchParams.set("state", state);
        return Response.redirect(dest.toString(), 302);
      }
    }

    // Token 交换
    if (path === "/oauth/token" && request.method === "POST") {
      await ensureOAuthTables(env);
      const form = await request.formData();
      const grantType = form.get("grant_type");
      if (grantType !== "authorization_code") {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      const code = form.get("code") || "";
      const redirectUri = form.get("redirect_uri") || "";
      const verifier = form.get("code_verifier") || "";

      const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code=?").bind(code).first();
      if (!row || row.expires_at < Date.now() || row.redirect_uri !== redirectUri) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      // PKCE 验证（如果有 challenge）
      if (row.code_challenge) {
        const hash = await sha256hex(verifier);
        // base64url 编码
        const expected = btoa(String.fromCharCode(...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
        ))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (expected !== row.code_challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
      }
      // 删除已用的 code
      await env.DB.prepare("DELETE FROM oauth_codes WHERE code=?").bind(code).run();
      // 发 token
      const token = "abot_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await env.DB.prepare("INSERT INTO oauth_tokens (token, created_at) VALUES (?,?)")
        .bind(token, Date.now()).run();
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 31536000 });
    }

    // ---- 以下为 MCP 代理（需鉴权） ----

    // 对外鉴权：GATEWAY_TOKEN 或 OAuth token
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let authed = false;
    if (env.GATEWAY_TOKEN && token === env.GATEWAY_TOKEN) {
      authed = true;
    } else if (token.startsWith("abot_")) {
      await ensureOAuthTables(env);
      const row = await env.DB.prepare("SELECT token FROM oauth_tokens WHERE token=?").bind(token).first();
      if (row) authed = true;
    }
    if (!authed) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // 路由匹配
    let route = null;
    let prefix = "";
    for (const [p, r] of Object.entries(ROUTES)) {
      if (path.startsWith(p)) {
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
    const rest = path.slice(prefix.length);
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
