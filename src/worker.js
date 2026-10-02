const ROUTES = {
  "/data/": { host: "https://abot-data.boliam.workers.dev", token_env: "INTERNAL_DATA" },
  "/mail/": { host: "https://resend-agent-mail-relay.boliam.workers.dev", token_env: "INTERNAL_MAIL" },
  "/health/": { host: "https://abot-health.boliam.workers.dev", token_env: "INTERNAL_HEALTH" },
  "/rules/": { host: "https://abot-rules.boliam.workers.dev", token_env: "INTERNAL_RULES" },
  "/secrets/": { host: "https://abot-secrets.boliam.workers.dev", token_env: "INTERNAL_SECRETS" },
};

function newId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function ensureOAuthTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gw_oauth_clients (
    client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gw_oauth_codes (
    email TEXT,
    code TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    code_challenge TEXT, expires_at INTEGER NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS gw_oauth_tokens (
    token TEXT PRIMARY KEY, email TEXT, created_at INTEGER NOT NULL)`).run();
  try { await env.DB.prepare("ALTER TABLE gw_oauth_tokens ADD COLUMN email TEXT").run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS provision_requests (
    id TEXT PRIMARY KEY, agent_name TEXT, reason TEXT, requested_email TEXT,
    status TEXT DEFAULT 'pending', email TEXT, secret_hash TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
  try { await env.DB.prepare("ALTER TABLE provision_requests ADD COLUMN secret_hash TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE provision_requests ADD COLUMN requested_email TEXT").run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS invite_codes (
    code_hash TEXT PRIMARY KEY, code TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    used_at TEXT, used_by TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS agent_tokens (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, request_id TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    revoked_at TEXT)`).run();
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
      await env.DB.prepare("INSERT INTO gw_oauth_clients (client_id, redirect_uris) VALUES (?,?)")
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
      const client = await env.DB.prepare("SELECT * FROM gw_oauth_clients WHERE client_id=?")
        .bind(clientId).first();
      if (!client) {
        return new Response("invalid client_id", { status: 400 });
      }
      const allowedUris = JSON.parse(client.redirect_uris || "[]");
      if (!allowedUris.includes(redirectUri)) {
        return new Response("invalid redirect_uri", { status: 400 });
      }

      if (request.method === "GET") {
        // 显示登录+授权页
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>aBot 授权</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:20px}
input{display:block;width:100%;padding:10px;margin:8px 0;font-size:15px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
button{background:#0066ff;color:#fff;border:0;padding:12px 32px;font-size:16px;border-radius:8px;cursor:pointer;margin-top:12px}</style>
</head><body>
<h2>aBot 网关授权</h2>
<p>客户端 <code>${clientId}</code> 请求访问你的 aBot 服务。</p>
<p style="color:#666">请输入你的 agent 邮箱和 Secret（在 admin 页获取）。</p>
<form method="POST">
<input type="hidden" name="client_id" value="${clientId}">
<input type="hidden" name="redirect_uri" value="${redirectUri}">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="code_challenge" value="${codeChallenge}">
<input type="email" name="email" placeholder="agent@abot.run" required>
<input type="password" name="secret" placeholder="ask_..." required>
<button type="submit">登录并授权</button>
</form></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        // 验证邮箱+secret
        const email = (form.get("email") || "").trim().toLowerCase();
        const secret = (form.get("secret") || "").trim();
        if (!email || !secret) {
          return new Response("需要邮箱和 Secret", { status: 400 });
        }
        const secretHash = await sha256hex(secret);
        const tokenRow = await env.DB.prepare(
          "SELECT email FROM agent_tokens WHERE token_hash=? AND revoked_at IS NULL"
        ).bind(secretHash).first();
        if (!tokenRow || tokenRow.email !== email) {
          return new Response("<html><body><h2>邮箱或 Secret 错误</h2><p><a href='javascript:history.back()'>返回重试</a></p></body></html>", 
            { status: 401, headers: { "Content-Type": "text/html;charset=utf-8" } });
        }
        const code = newId("code");
        const expiresAt = Date.now() + 10 * 60 * 1000;
        await env.DB.prepare(
          "INSERT INTO gw_oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at, email) VALUES (?,?,?,?,?,?)"
        ).bind(code, clientId, redirectUri, codeChallenge || null, expiresAt, email).run();
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
      // password grant：邮箱+secret 换 token（给 agent 用）
      if (grantType === "password") {
        const username = (form.get("username") || "").trim().toLowerCase();
        const password = (form.get("password") || "").trim();
        if (!username || !password) {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        const hash = await sha256hex(password);
        const row = await env.DB.prepare(
          "SELECT email FROM provision_requests WHERE email=? AND secret_hash=? AND status='approved'"
        ).bind(username, hash).first();
        if (!row) {
          return Response.json({ error: "invalid_grant", message: "邮箱或 secret 不正确" }, { status: 401 });
        }
        const token = "abot_" + [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
        await env.DB.prepare("INSERT INTO gw_oauth_tokens (token, email, created_at) VALUES (?,?,?)")
          .bind(token, row.email, Date.now()).run();
        return Response.json({ access_token: token, token_type: "Bearer", email: row.email });
      }
      if (grantType !== "authorization_code") {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      const code = form.get("code") || "";
      const redirectUri = form.get("redirect_uri") || "";
      const verifier = form.get("code_verifier") || "";

      const row = await env.DB.prepare("SELECT * FROM gw_oauth_codes WHERE code=?").bind(code).first();
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
      await env.DB.prepare("DELETE FROM gw_oauth_codes WHERE code=?").bind(code).run();
      // 发 token（绑定邮箱）
      const token = "abot_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      await env.DB.prepare("INSERT INTO gw_oauth_tokens (token, email, created_at) VALUES (?,?,?)")
        .bind(token, row.email || null, Date.now()).run();
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 31536000 });
    }

    // ---- Provision：新 agent 申请身份（需人工审核） ----

    // 提交申请（限流：同一 IP 1 小时最多 3 次）
    // 申请说明（agent 自助读取）
    if (path === "/provision/info" && request.method === "GET") {
      return Response.json({
        service: "aBot Agent 邮箱申请",
        note: "已迁移到 https://mail.abot.run/signup",
        steps: [
          "向你的主人要一个邀请码（一小时有效，一次性）",
          "想一个你想要的邮箱地址，必须是 xxx@abot.run 格式",
          "POST https://mail.abot.run/signup 提交申请",
          "提交后等待主人审核，通过后主人会联系你",
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
      // 已批准的 agent 列表
      const agents = await env.DB.prepare(
        "SELECT id, agent_name, email, created_at FROM provision_requests WHERE status='approved' AND email IS NOT NULL ORDER BY created_at DESC"
      ).all();
      const agentItems = (agents.results || []).map((a, i) =>
        `<div class="agent-row" style="display:flex;align-items:center;gap:8px;margin:6px 0;padding:8px;border:1px solid #ddd;border-radius:6px">
          <div style="flex:1"><b>${a.agent_name || "(未命名)"}</b><br><code>${a.email}</code></div>
          <button data-action="rotate" data-id="${a.id}" style="padding:4px 12px;font-size:12px">换 Secret</button>
          <button data-action="revoke" data-id="${a.id}" style="padding:4px 12px;font-size:12px;background:#ffebee">吊销</button>
        </div>`
      ).join("");
      const items = (rows.results || []).map((r) =>
        `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0">
          <b>${r.agent_name || "(未命名)"}</b> <span style="color:#666">${r.id}</span><br>
          <span>${r.reason || ""}</span><br>
          <span>状态: ${r.status}</span> <span style="color:#999">${r.created_at}</span><br>
          ${r.status === "approved" && r.email ? `<span style="color:#2e7d32">邮箱: ${r.email}</span><br>` : ""}
          ${r.status === "pending" ? `
            <div class="req-row" style="margin-top:8px">
              ${r.requested_email ? `<span style="color:#666">申请想要：${r.requested_email}</span><br>` : ""}
              <button data-action="approve" data-id="${r.id}">通过并建邮箱</button>
              <button data-action="deny" data-id="${r.id}">拒绝</button>
            </div>` : ""}
        </div>`
      ).join("");
      return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>aBot 审核</title><script>
/*__ADMIN_JS__*/
</script>
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
<button data-action="invite">生成邀请码</button>
${codeItems ? `<div style="margin-top:8px"><b>有效邀请码：</b>${codeItems}</div>` : `<div style="color:#999;margin-top:8px">暂无有效邀请码</div>`}<div id="invite-result" style="display:none;background:#e3f2fd;border:2px solid #2196f3;border-radius:6px;padding:10px;margin-top:8px"></div>
</div>
<div style="margin:16px 0;padding:12px;border:1px solid #999;border-radius:8px">
<b>已接入 Agent</b> <span style="color:#666">换 Secret 后旧 secret 失效，需重新发给 agent；吊销后该邮箱所有 token 失效</span>
${agentItems || `<div style="color:#999;margin-top:8px">暂无</div>`}
</div>
${items || "<p>暂无申请</p>"}</body></html>`,
        { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    const isAdminHost2 = url.hostname === "admin.abot.run";
    const approvePath = isAdminHost2 ? "/approve" : "/admin/approve";
    const denyPath = isAdminHost2 ? "/deny" : "/admin/deny";
    const invitePath = isAdminHost2 ? "/invite" : "/admin/invite";
    const rotatePath = isAdminHost2 ? "/rotate" : "/admin/rotate";
    const revokePath = isAdminHost2 ? "/revoke" : "/admin/revoke";
    // 吊销：该邮箱所有 token 失效
    if (path === revokePath && request.method === "POST") {
      try {
        await ensureOAuthTables(env);
        const body = await request.json();
        const id = body.id || "";
        const req = await env.DB.prepare("SELECT email FROM provision_requests WHERE id=?").bind(id).first();
        if (req && req.email) {
          await env.DB.prepare("UPDATE agent_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email=?").bind(req.email).run();
          await env.DB.prepare("DELETE FROM gw_oauth_tokens WHERE email=?").bind(req.email).run();
        }
        return Response.json({ ok: true });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }
    // 换 Secret：生成新的 ask_，旧的失效
    if (path === rotatePath && request.method === "POST") {
      try {
        await ensureOAuthTables(env);
        const body = await request.json();
        const id = body.id || "";
        const req = await env.DB.prepare("SELECT email FROM provision_requests WHERE id=? AND status='approved'").bind(id).first();
        if (!req || !req.email) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        const secret = "ask_" + [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
        const secretHash = await sha256hex(secret);
        await env.DB.prepare("UPDATE agent_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email=?").bind(req.email).run();
        await env.DB.prepare("DELETE FROM gw_oauth_tokens WHERE email=?").bind(req.email).run();
        await env.DB.prepare("UPDATE provision_requests SET secret_hash=? WHERE id=?").bind(secretHash, id).run();
        await env.DB.prepare("INSERT INTO agent_tokens (token_hash, email, request_id) VALUES (?,?,?)").bind(secretHash, req.email, id).run();
        return Response.json({ ok: true, email: req.email, secret });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }
    // 生成邀请码（只显示一次）
    if (path === invitePath && request.method === "POST") {
      await ensureOAuthTables(env);
      const code = "inv_" + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
      const hash = await sha256hex(code);
      await env.DB.prepare("INSERT INTO invite_codes (code_hash, code) VALUES (?,?)").bind(hash, code).run();
      return Response.json({ ok: true, code });
    }
    if ((path === approvePath || path === denyPath) && request.method === "POST") {
      try {
      await ensureOAuthTables(env);
      const body = await request.json();
      const id = body.id || "";
      const approve = path === approvePath;
      if (!approve) {
        await env.DB.prepare("UPDATE provision_requests SET status='denied' WHERE id=?").bind(id).run();
        return Response.json({ ok: true });
      }
      // 通过：手动邮箱 + 生成 secret + 建 mailbox 记录
      const email = (body.email || "").trim().toLowerCase();
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
      // 同步到权限表（网关 MCP 鉴权查这张）
      await env.DB.prepare("INSERT OR REPLACE INTO agent_tokens (token_hash, email, request_id) VALUES (?,?,?)")
        .bind(secretHash, email, id).run();
      // 建 mailbox 记录（mail 服务读这张表做隔离）
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mailboxes (
        email TEXT PRIMARY KEY, request_id TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
      await env.DB.prepare("INSERT OR IGNORE INTO mailboxes (email, request_id) VALUES (?,?)").bind(email, id).run();
      return Response.json({ ok: true, email, secret });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }

    // ---- 以下为 MCP 代理（需鉴权） ----

    // 对外鉴权：GATEWAY_TOKEN / OAuth token(abot_)
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let authed = false;
    let agentEmail = null;
    if (env.GATEWAY_TOKEN && token === env.GATEWAY_TOKEN) {
      authed = true;
    } else if (token.startsWith("abot_")) {
      await ensureOAuthTables(env);
      const row = await env.DB.prepare("SELECT email FROM gw_oauth_tokens WHERE token=?").bind(token).first();
      if (row) {
        authed = true;
        agentEmail = row.email || null;
      }
    }
    if (!authed) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // ---- 统一 MCP 网关：POST /mcp ----
    if (path === "/mcp" && request.method === "POST") {
      try {
        const rpc = await request.json();
        const method = rpc.method;
        const rpcId = rpc.id;
        
        // MCP 服务注册表
        const MCP_SERVICES = [
          { prefix: "mail", route: ROUTES["/mail/"] },
          { prefix: "data", route: ROUTES["/data/"] },
          { prefix: "health", route: ROUTES["/health/"] },
          { prefix: "rules", route: ROUTES["/rules/"] },
          { prefix: "secrets", route: ROUTES["/secrets/"] },
        ];
        
        async function callBackend(svc, rpcPayload) {
          const token = env[svc.route.token_env];
          const headers = {
            "Content-Type": "application/json",
            "X-Internal-Token": token,
          };
          if (agentEmail) headers["X-Abot-Owner-Email"] = agentEmail;
          const resp = await fetch(svc.route.host + "/mcp", {
            method: "POST",
            headers,
            body: JSON.stringify(rpcPayload),
          });
          return resp.json();
        }
        
        if (method === "initialize") {
          return Response.json({
            jsonrpc: "2.0", id: rpcId,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "aBot", version: "1.0.0" },
            },
          });
        }
        
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        
        if (method === "tools/list") {
          const allTools = [];
          for (const svc of MCP_SERVICES) {
            try {
              const r = await callBackend(svc, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
              const tools = (r.result && r.result.tools) || [];
              for (const t of tools) {
                allTools.push({
                  name: svc.prefix + "_" + t.name,
                  description: "[" + svc.prefix + "] " + (t.description || ""),
                  inputSchema: t.inputSchema,
                });
              }
            } catch (e) {
              // 单个服务失败不影响其他
            }
          }
          return Response.json({ jsonrpc: "2.0", id: rpcId, result: { tools: allTools } });
        }
        
        if (method === "tools/call") {
          const fullName = (rpc.params && rpc.params.name) || "";
          const args = (rpc.params && rpc.params.arguments) || {};
          const idx = fullName.indexOf("_");
          if (idx < 0) {
            return Response.json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "unknown tool: " + fullName } });
          }
          const prefix = fullName.slice(0, idx);
          const realName = fullName.slice(idx + 1);
          const svc = MCP_SERVICES.find(function(s) { return s.prefix === prefix; });
          if (!svc) {
            return Response.json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "unknown service: " + prefix } });
          }
          const r = await callBackend(svc, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: realName, arguments: args } });
          // 透传后端的 result/error
          if (r.error) {
            return Response.json({ jsonrpc: "2.0", id: rpcId, error: r.error });
          }
          return Response.json({ jsonrpc: "2.0", id: rpcId, result: r.result });
        }
        
        return Response.json({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "method not found: " + method } });
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: String(e.message || e) } }, { status: 500 });
      }
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
    // agent 身份透传（后端信任此头做隔离）
    if (agentEmail) {
      headers.set("X-Abot-Owner-Email", agentEmail);
    }
    // 移除外部 Authorization，后端只认内部 token + 身份头
    headers.delete("Authorization");

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

