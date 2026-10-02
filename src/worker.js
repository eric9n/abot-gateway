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
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_codes (
    code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    code_challenge TEXT, expires_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS oauth_tokens (
    token TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS provision_requests (
    id TEXT PRIMARY KEY, agent_name TEXT, reason TEXT, requested_email TEXT,
    status TEXT DEFAULT 'pending', email TEXT, secret_hash TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
  try { await env.DB.prepare("ALTER TABLE provision_requests ADD COLUMN secret_hash TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE provision_requests ADD COLUMN requested_email TEXT").run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS invite_codes (
    code_hash TEXT PRIMARY KEY, code TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    used_at TEXT, used_by TEXT)`).run();
  // 老表补列
  try { await env.DB.prepare("ALTER TABLE invite_codes ADD COLUMN code TEXT").run(); } catch {}
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

    // 调试：D1 连接测试
    if (path === "/debug/db" && request.method === "GET") {
      try {
        const r = await env.DB.prepare("SELECT 1 as one").first();
        return Response.json({ ok: true, db: !!r });
      } catch (e) {
        return Response.json({ ok: false, error: String(e && e.message || e) });
      }
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

    // ---- Provision：新 agent 申请身份（需人工审核） ----

    // 提交申请（限流：同一 IP 1 小时最多 3 次）
    // 申请说明（agent 自助读取）
    if (path === "/provision/info" && request.method === "GET") {
      return Response.json({
        service: "aBot Agent 邮箱申请",
        steps: [
          "1. 向你的主人要一个邀请码（一小时有效，一次性）",
          "2. 想一个你想要的邮箱地址，必须是 xxx@abot.run 格式",
          "3. POST /provision/request 提交申请，带上 invite_code、agent_name、reason、requested_email",
          "4. 轮询 GET /provision/status?id=xxx 等待人工审核",
          "5. 通过后，主人会私下把 secret 发给你（申请接口不返回 secret）",
          "6. 拿着邮箱 + secret 走 OAuth connect 流程接入 MCP",
        ],
        request_format: {
          invite_code: "inv_...（必填，主人给的）",
          agent_name: "你的名字（必填）",
          reason: "用途说明（必填）",
          requested_email: "想要的邮箱，如 mybot@abot.run（选填，主人可改）",
        },
      });
    }

    if (path === "/provision/request" && request.method === "POST") {
      await ensureOAuthTables(env);
      let body;
      try { body = await request.json(); } catch { body = {}; }
      // 邀请码必填，一次性
      const inviteCode = (body.invite_code || "").trim();
      if (!inviteCode) {
        return Response.json({ error: "invite_code_required", message: "需要邀请码才能申请" }, { status: 400 });
      }
      const codeHash = await sha256hex(inviteCode);
      const codeRow = await env.DB.prepare("SELECT code_hash, used_at, created_at FROM invite_codes WHERE code_hash=?").bind(codeHash).first();
      if (!codeRow) {
        return Response.json({ error: "invalid_invite_code" }, { status: 403 });
      }
      if (codeRow.used_at) {
        return Response.json({ error: "invite_code_used" }, { status: 403 });
      }
      // 1小时有效期
      const createdMs = new Date(codeRow.created_at).getTime();
      if (Date.now() - createdMs > 3600 * 1000) {
        return Response.json({ error: "invite_code_expired", message: "邀请码已过期（1小时有效）" }, { status: 403 });
      }
      // 简单限流：最近1小时最多10个申请
      const recent = await env.DB.prepare(
        "SELECT COUNT(*) as c FROM provision_requests WHERE created_at > datetime('now','-1 hour')"
      ).first();
      if (recent && recent.c >= 10) {
        return Response.json({ error: "rate_limited" }, { status: 429 });
      }
      const id = newId("prov");
      const requestedEmail = (body.requested_email || "").trim().toLowerCase() || null;
      await env.DB.prepare(
        "INSERT INTO provision_requests (id, agent_name, reason, requested_email, status) VALUES (?,?,?,?,?)"
      ).bind(id, body.agent_name || null, body.reason || null, requestedEmail, "pending").run();
      // 标记邀请码已用
      await env.DB.prepare("UPDATE invite_codes SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), used_by=? WHERE code_hash=?").bind(id, codeHash).run();
      return Response.json({ id, status: "pending", message: "等待人工审核" });
    }

    // 查申请状态
    if (path === "/provision/status" && request.method === "GET") {
      await ensureOAuthTables(env);
      const id = url.searchParams.get("id") || "";
      const row = await env.DB.prepare("SELECT id, status, email FROM provision_requests WHERE id=?")
        .bind(id).first();
      if (!row) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ id: row.id, status: row.status, email: row.email || null });
    }

    // 管理页（Cloudflare Access 保护，代码内不鉴权）
    // 管理页：admin.abot.run/ 或 abot.run/admin（Cloudflare Access 保护）
    const host = url.hostname;
    const isAdmin = host === "admin.abot.run" ? (path === "/" || path === "") : (path === "/admin");
    if (isAdmin && request.method === "GET") {
      await ensureOAuthTables(env);
      const rows = await env.DB.prepare(
        "SELECT id, agent_name, reason, requested_email, status, email, created_at FROM provision_requests ORDER BY created_at DESC LIMIT 50"
      ).all();
      // 有效邀请码（未使用、1小时内、有明文）
      const codes = await env.DB.prepare(
        "SELECT code, created_at FROM invite_codes WHERE used_at IS NULL AND code IS NOT NULL AND created_at > datetime('now','-1 hour') ORDER BY created_at DESC"
      ).all();
      const codeItems = (codes.results || []).map((c, i) =>
        `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
          <code id="vc${i}" style="flex:1">${c.code}</code>
          <button onclick="navigator.clipboard.writeText(document.getElementById('vc${i}').innerText).then(()=>{this.innerText='已复制✓';setTimeout(()=>this.innerText='复制',1500)})" style="padding:4px 12px;font-size:12px">复制</button>
          <span style="color:#999;font-size:12px">${c.created_at}</span>
        </div>`
      ).join("");
      const formBase = (url.hostname === "admin.abot.run") ? "" : "/admin";
      const items = (rows.results || []).map((r) =>
        `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0">
          <b>${r.agent_name || "(未命名)"}</b> <span style="color:#666">${r.id}</span><br>
          <span>${r.reason || ""}</span><br>
          <span>状态: ${r.status}</span> <span style="color:#999">${r.created_at}</span><br>
          ${r.status === "approved" && r.email ? `<span style="color:#2e7d32">邮箱: ${r.email}</span><br>` : ""}
          ${r.status === "pending" ? `
            <form method="POST" action="${formBase}/approve" style="margin-top:8px">
              <input type="hidden" name="id" value="${r.id}">
              ${r.requested_email ? `<span style="color:#666">申请想要：${r.requested_email}</span><br>` : ""}
              <input type="text" name="email" placeholder="agent_xxx@abot.run" value="${r.requested_email || ""}" style="padding:6px;width:220px" required>
              <button>通过并建邮箱</button>
            </form>
            <form method="POST" action="${formBase}/deny" style="display:inline">
              <input type="hidden" name="id" value="${r.id}">
              <button>拒绝</button>
            </form>` : ""}
        </div>`
      ).join("");
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>aBot 审核</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px}
button{padding:8px 20px;margin:4px;font-size:14px;cursor:pointer}
.newcode{background:#e8f5e9;border:1px solid #4caf50;border-radius:8px;padding:12px;margin:12px 0;word-break:break-all}</style>
</head><body><h2>aBot 新 Agent 审核</h2>
${url.searchParams.get("newcode") ? `<div class="newcode"><b>新邀请码（只显示一次）：</b><br>
<div style="display:flex;align-items:center;gap:8px;margin-top:8px">
<code id="inviteCode" style="flex:1;font-size:15px">${url.searchParams.get("newcode")}</code>
<button onclick="navigator.clipboard.writeText(document.getElementById('inviteCode').innerText).then(()=>{this.innerText='已复制✓';setTimeout(()=>this.innerText='复制',1500)})" style="padding:6px 14px;font-size:13px">复制</button>
</div></div>` : ""}
${url.searchParams.get("newsecret") ? `<div class="newcode"><b>新 agent 密钥（只显示一次，请复制发给 agent）：</b><br>
<div style="margin-top:8px">邮箱: <code>${url.searchParams.get("email")}</code></div>
<div style="display:flex;align-items:center;gap:8px;margin-top:8px">
<code id="agentSecret" style="flex:1;font-size:14px">${url.searchParams.get("newsecret")}</code>
<button onclick="navigator.clipboard.writeText(document.getElementById('agentSecret').innerText).then(()=>{this.innerText='已复制✓';setTimeout(()=>this.innerText='复制',1500)})" style="padding:6px 14px;font-size:13px">复制</button>
</div></div>` : ""}
<div style="margin:16px 0;padding:12px;border:1px dashed #999;border-radius:8px">
<b>邀请码</b> <span style="color:#666">生成一次码发给 agent，申请时必填（1小时有效）</span><br>
<form method="POST" action="${formBase}/invite" style="display:inline"><button>生成邀请码</button></form>
${codeItems ? `<div style="margin-top:8px"><b>有效邀请码：</b>${codeItems}</div>` : `<div style="color:#999;margin-top:8px">暂无有效邀请码</div>`}
</div>
${items || "<p>暂无申请</p>"}</body></html>`,
        { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    const isAdminHost2 = url.hostname === "admin.abot.run";
    const approvePath = isAdminHost2 ? "/approve" : "/admin/approve";
    const denyPath = isAdminHost2 ? "/deny" : "/admin/deny";
    const invitePath = isAdminHost2 ? "/invite" : "/admin/invite";
    // 生成邀请码（只显示一次）
    if (path === invitePath && request.method === "POST") {
      await ensureOAuthTables(env);
      const code = "inv_" + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
      const hash = await sha256hex(code);
      await env.DB.prepare("INSERT INTO invite_codes (code_hash, code) VALUES (?,?)").bind(hash, code).run();
      const back = isAdminHost2 ? url.origin + "/" : url.origin + "/admin";
      // 通过 query 参数一次性显示（简单版）
      return Response.redirect(back + "?newcode=" + encodeURIComponent(code), 302);
    }
    if ((path === approvePath || path === denyPath) && request.method === "POST") {
      await ensureOAuthTables(env);
      const form = await request.formData();
      const id = form.get("id") || "";
      const approve = path === approvePath;
      const back = isAdminHost2 ? url.origin + "/" : url.origin + "/admin";
      if (!approve) {
        await env.DB.prepare("UPDATE provision_requests SET status='denied' WHERE id=?").bind(id).run();
        return Response.redirect(back, 302);
      }
      // 通过：手动邮箱 + 生成 secret + 建 mailbox 记录
      const email = (form.get("email") || "").trim().toLowerCase();
      if (!email || !email.endsWith("@abot.run")) {
        return Response.json({ error: "invalid_email", message: "邮箱必须是 xxx@abot.run" }, { status: 400 });
      }
      // 邮箱不能重复
      const dup = await env.DB.prepare("SELECT id FROM provision_requests WHERE email=? AND status='approved'").bind(email).first();
      if (dup) {
        return Response.json({ error: "email_taken", message: "该邮箱已分配" }, { status: 400 });
      }
      const secret = "ask_" + [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
      const secretHash = await sha256hex(secret);
      await env.DB.prepare("UPDATE provision_requests SET status='approved', email=?, secret_hash=? WHERE id=?")
        .bind(email, secretHash, id).run();
      // 建 mailbox 记录（mail 服务读这张表做隔离）
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mailboxes (
        email TEXT PRIMARY KEY, request_id TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
      await env.DB.prepare("INSERT OR IGNORE INTO mailboxes (email, request_id) VALUES (?,?)").bind(email, id).run();
      // secret 只显示一次
      return Response.redirect(back + "?newsecret=" + encodeURIComponent(secret) + "&email=" + encodeURIComponent(email), 302);
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
