// 路径前缀 → Service Binding 名。请求走 env[binding].fetch()，不经公网、不带内部 token。
const ROUTES = {
  "/data/": "BACKEND_DATA",
  "/mail/": "BACKEND_MAIL",
  "/health/": "BACKEND_HEALTH",
  "/rules/": "BACKEND_RULES",
  "/secrets/": "BACKEND_SECRETS",
  "/sms/": "BACKEND_SMS",
};

function routeServiceName(prefix) {
  return prefix.replace(/^\//, "").replace(/\/$/, "");
}

// 后端异常：固定 502，不附后端原文，避免泄漏内部信息
function backendUnavailable(service, detail) {
  const body = { error: "backend_unavailable", service };
  if (detail) body.detail = detail;
  return Response.json(body, { status: 502 });
}

function serviceBinding(env, name) {
  const binding = env[name];
  if (!binding || typeof binding.fetch !== "function") return null;
  return binding;
}

function newId(prefix) {
  const r = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(36)).join("").replace(/[^a-z0-9]/g, "");
  return prefix + "_" + r.slice(0, 12) + Date.now().toString(36);
}

// HTML 转义（防 XSS）
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 构建时 build.js 把 src/admin.js 以 JSON 字符串字面量替换到这里
const ADMIN_JS = /*__ADMIN_JS__*/"console.error(\"admin.js 未嵌入：请先 node build.js 再部署\");";

const STATUS_LABELS = { pending: "待审核", approved: "已通过", denied: "已拒绝", revoked: "已吊销" };

// 通用 500（不泄漏内部细节）
function internalError() {
  return Response.json({ ok: false, error: "internal_error" }, { status: 500 });
}

// created_at 统一按 ISO（strftime %Y-%m-%dT%H:%M:%fZ）比较。isoTime() 把老格式 'YYYY-MM-DD HH:MM:SS'（UTC）也转成 ISO，
// 避免 'T' 与空格混比的字符串错位。
const HOUR_AGO = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')";
function isoTime(col) {
  return "strftime('%Y-%m-%dT%H:%M:%fZ'," + col + ")";
}

let schemaReady = false;
async function ensureOAuthTables(env) {
  if (schemaReady) return;
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
  // mail 服务读这张表做隔离
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mailboxes (
    email TEXT PRIMARY KEY, request_id TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).run();
  // 老表补列
  try { await env.DB.prepare("ALTER TABLE invite_codes ADD COLUMN code TEXT").run(); } catch {}
  // 一个邮箱只分配给一个申请（含已吊销）；已有重复数据时建索引会失败，不阻塞其它功能
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_provision_requests_email ON provision_requests(email) WHERE email IS NOT NULL").run(); } catch {}
  // 懒清理：过期 code / token；用过或过期的邀请码不留明文
  try { await env.DB.prepare(`UPDATE invite_codes SET code=NULL WHERE code IS NOT NULL AND (used_at IS NOT NULL OR ${isoTime("created_at")} <= ${HOUR_AGO})`).run(); } catch {}
  try { await env.DB.prepare("DELETE FROM gw_oauth_codes WHERE expires_at < ?").bind(Date.now()).run(); } catch {}
  try { await env.DB.prepare("DELETE FROM gw_oauth_tokens WHERE created_at < ?").bind(Date.now() - 365 * 24 * 3600 * 1000).run(); } catch {}
  schemaReady = true;
}

const EMAIL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@abot\.run$/;

// 返回规范化后的 agent 邮箱，不合法返回 null
function normalizeEmail(v) {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.includes("..")) return null;
  return email;
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SIGNUP_INFO = {
  service: "aBot 邮箱申请",
  steps: [
    "向你的主人要一个邀请码（一小时有效，一次性）",
    "想一个你想要的邮箱地址，必须是 xxx@abot.run 格式",
    "POST https://abot.run/signup 提交申请",
    "提交后拿到申请 id，可用 GET https://abot.run/provision/status?id=<申请 id> 查进度",
    "审核通过后，主人会把邮箱和 secret（ask_...）发给你",
    "用邮箱 + secret 换 access_token：POST https://abot.run/oauth/token，表单格式（application/x-www-form-urlencoded，不是 JSON），字段 grant_type=password、username=<邮箱>、password=<secret>",
    "以后调 POST https://abot.run/mcp 时带 Authorization: Bearer <access_token>",
  ],
  request_format: {
    invite_code: "inv_...（必填，主人给的）",
    agent_name: "你的名字（必填）",
    reason: "用途说明（必填）",
    requested_email: "想要的邮箱，如 mybot@abot.run（选填，主人可改）",
  },
  apply_url: "https://abot.run/signup",
  status_url: "https://abot.run/provision/status?id=<申请 id>",
  token: {
    url: "https://abot.run/oauth/token",
    content_type: "application/x-www-form-urlencoded",
    example: "curl -X POST https://abot.run/oauth/token -d grant_type=password -d username=mybot@abot.run -d password=ask_...",
    response: '{"access_token":"abot_...","token_type":"Bearer","email":"mybot@abot.run"}',
  },
  mcp: {
    url: "https://abot.run/mcp",
    transport: "POST JSON-RPC 2.0，响应为普通 JSON（不支持 GET / SSE）",
    auth: "Authorization: Bearer <access_token>；标准 MCP 客户端也可以只配置这个 URL，通过 /.well-known/oauth-protected-resource 自动走 OAuth 授权码流程，在授权页填邮箱和 secret",
    methods: ["initialize", "tools/list", "tools/call"],
    tool_names: "工具名带服务前缀，如 mail_send、data_query；先调 tools/list 查看",
  },
};

// 页面只含 SIGNUP_INFO 的静态文本；仍要 esc()，否则 "<access_token>" 会被浏览器当成标签吞掉
function signupPage(request) {
  const accept = request.headers.get("accept") || "";
  if (!accept.includes("text/html")) return Response.json(SIGNUP_INFO);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>aBot 邮箱申请</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px;line-height:1.6}
code{background:#f5f5f5;padding:2px 6px;border-radius:4px}pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto}</style>
</head><body><h2>aBot 邮箱申请</h2>
<ol>${SIGNUP_INFO.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<h3>申请格式</h3><pre>${esc(JSON.stringify(SIGNUP_INFO.request_format, null, 2))}</pre>
<p>提交地址：<code>POST ${esc(SIGNUP_INFO.apply_url)}</code></p>
<h3>换 access_token</h3><pre>${esc(JSON.stringify(SIGNUP_INFO.token, null, 2))}</pre>
<h3>连接 MCP</h3><pre>${esc(JSON.stringify(SIGNUP_INFO.mcp, null, 2))}</pre></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

// ---- Cloudflare Access JWT 校验（admin 纵深防御） ----
const ACCESS_TEAM = "boliam.cloudflareaccess.com";
// aBot Admin（admin.abot.run）的 AUD tag。JWT 的 aud 是这个值，不是应用 UUID。
const ACCESS_AUD = "20d26cf162fe474df036d3de12e12f893893bd7b031a4b03ec50ce3e4cdbaf99";
const ACCESS_ISS = "https://" + ACCESS_TEAM;
const JWT_SKEW_SEC = 60;
let jwksCache = null;
let jwksCacheAt = 0;

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// force=true 时跳过缓存（遇到未知 kid 说明 Access 可能轮换了密钥）。强制刷新至少间隔 30 秒，防止被伪造 kid 刷爆。
let jwksForcedAt = 0;
async function getAccessJwks(force) {
  if (!force && jwksCache && Date.now() - jwksCacheAt < 10 * 60 * 1000) return jwksCache;
  if (force && jwksCache && Date.now() - jwksForcedAt < 30 * 1000) return jwksCache;
  if (force) jwksForcedAt = Date.now();
  const r = await fetch("https://" + ACCESS_TEAM + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("jwks fetch failed");
  jwksCache = await r.json();
  jwksCacheAt = Date.now();
  return jwksCache;
}

// 返回 null 表示通过，否则返回 403 Response
async function requireAccess(request) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion") || "";
  if (!jwt) {
    return new Response("forbidden: Cloudflare Access required", { status: 403 });
  }
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("bad jwt");
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (header.alg !== "RS256") throw new Error("bad alg");
    const now = Date.now() / 1000;
    if (typeof payload.exp !== "number" || payload.exp + JWT_SKEW_SEC < now) throw new Error("expired");
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf - JWT_SKEW_SEC > now)) throw new Error("not yet valid");
    if (payload.iss !== ACCESS_ISS) throw new Error("bad iss");
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(ACCESS_AUD) : aud === ACCESS_AUD;
    if (!audOk) throw new Error("bad aud");
    if (typeof header.kid !== "string" || !header.kid) throw new Error("no kid");
    const findKey = (jwks) => (jwks.keys || []).find((k) => k.kid === header.kid);
    let jwk = findKey(await getAccessJwks(false));
    if (!jwk) jwk = findKey(await getAccessJwks(true));
    if (!jwk) throw new Error("unknown kid");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    if (!ok) throw new Error("bad signature");
    return null;
  } catch (e) {
    return new Response("forbidden: invalid Access token", { status: 403 });
  }
}

const ADMIN_HOST = "admin.abot.run";
const ADMIN_ORIGIN = "https://" + ADMIN_HOST;
const ADMIN_POST_PATHS = ["/approve", "/deny", "/invite", "/rotate", "/revoke"];

// 管理页 POST 的 CSRF 防护：只收 JSON，且必须来自 admin 页本身
function rejectCrossSite(request) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const origin = request.headers.get("Origin");
  const sameOrigin = origin ? origin === ADMIN_ORIGIN : request.headers.get("Sec-Fetch-Site") === "same-origin";
  if (type === "application/json" && sameOrigin) return null;
  return Response.json({ ok: false, error: "csrf_rejected" }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

function adminPageHeaders(nonce) {
  return {
    "Content-Type": "text/html;charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'nonce-" + nonce + "'",
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
}

function newSecret() {
  return "ask_" + [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
}

// 管理页 POST。调用前已校验 Access JWT、CSRF，解析好 JSON body 并建好表；异常由调用方转成 500。
async function handleAdminPost(path, body, env) {
  const id = typeof body.id === "string" ? body.id : "";

  // 生成邀请码（只显示一次）
  if (path === "/invite") {
    const code = "inv_" + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
    const hash = await sha256hex(code);
    await env.DB.prepare("INSERT INTO invite_codes (code_hash, code) VALUES (?,?)").bind(hash, code).run();
    return Response.json({ ok: true, code });
  }

  // 吊销：申请标记 revoked，secret / token / 授权码全部失效
  if (path === "/revoke") {
    const req = await env.DB.prepare("SELECT email, status FROM provision_requests WHERE id=?").bind(id).first();
    if (!req || !req.email) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    if (req.status !== "approved") {
      return Response.json({ ok: false, error: "not_approved", message: "该申请当前不是已通过状态" }, { status: 409 });
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE provision_requests SET status='revoked', secret_hash=NULL WHERE id=?").bind(id),
      env.DB.prepare("UPDATE agent_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email=? AND revoked_at IS NULL").bind(req.email),
      env.DB.prepare("DELETE FROM gw_oauth_tokens WHERE email=?").bind(req.email),
      env.DB.prepare("DELETE FROM gw_oauth_codes WHERE email=?").bind(req.email),
    ]);
    return Response.json({ ok: true });
  }

  // 换 Secret：生成新的 ask_，旧的失效（仅限 approved）
  if (path === "/rotate") {
    const req = await env.DB.prepare("SELECT email FROM provision_requests WHERE id=? AND status='approved'").bind(id).first();
    if (!req || !req.email) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    const secret = newSecret();
    const secretHash = await sha256hex(secret);
    // 新 token 只在申请仍为 approved 时写入，避免与并发吊销交错后复活凭证
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE agent_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email=? AND revoked_at IS NULL").bind(req.email),
      env.DB.prepare("DELETE FROM gw_oauth_tokens WHERE email=?").bind(req.email),
      env.DB.prepare("DELETE FROM gw_oauth_codes WHERE email=?").bind(req.email),
      env.DB.prepare("UPDATE provision_requests SET secret_hash=? WHERE id=? AND status='approved'").bind(secretHash, id),
      env.DB.prepare("INSERT INTO agent_tokens (token_hash, email, request_id) SELECT ?, email, id FROM provision_requests WHERE id=? AND status='approved' AND email=?").bind(secretHash, id, req.email),
    ]);
    if (results[4].meta.changes !== 1) {
      return Response.json({ ok: false, error: "not_approved", message: "该申请已不是已通过状态" }, { status: 409 });
    }
    return Response.json({ ok: true, email: req.email, secret });
  }

  if (path === "/deny") {
    const r = await env.DB.prepare("UPDATE provision_requests SET status='denied' WHERE id=? AND status='pending'").bind(id).run();
    if (r.meta.changes === 1) return Response.json({ ok: true });
    const cur = await env.DB.prepare("SELECT status FROM provision_requests WHERE id=?").bind(id).first();
    if (!cur) return Response.json({ ok: false, error: "not_found", message: "申请不存在" }, { status: 404 });
    if (cur.status === "approved") {
      return Response.json({ ok: false, error: "already_approved", message: "已通过的申请不能拒绝，请用「吊销」" }, { status: 409 });
    }
    return Response.json({ ok: false, error: "not_pending", message: "该申请已处理（" + cur.status + "）" }, { status: 409 });
  }

  if (path === "/approve") {
    // 通过：手动邮箱 + 生成 secret + 建 mailbox 记录
    const email = normalizeEmail(body.email);
    if (!email) {
      return Response.json({ ok: false, error: "invalid_email", message: "邮箱必须是 xxx@abot.run，只能含小写字母、数字和 ._-，首尾为字母或数字" }, { status: 400 });
    }
    const cur = await env.DB.prepare("SELECT status FROM provision_requests WHERE id=?").bind(id).first();
    if (!cur) return Response.json({ ok: false, error: "not_found", message: "申请不存在" }, { status: 404 });
    if (cur.status !== "pending") {
      return Response.json({ ok: false, error: "not_pending", message: "该申请已处理（" + cur.status + "）" }, { status: 409 });
    }
    // 分配过的邮箱（含已吊销）不再复用，避免新 agent 读到旧邮件
    const dup = await env.DB.prepare(
      "SELECT 1 AS x FROM provision_requests WHERE email=? UNION ALL SELECT 1 FROM mailboxes WHERE email=? LIMIT 1"
    ).bind(email, email).first();
    if (dup) {
      return Response.json({ ok: false, error: "email_taken", message: "该邮箱已分配" }, { status: 409 });
    }
    const secret = newSecret();
    const secretHash = await sha256hex(secret);
    // 一个事务：只有把 pending 改成 approved 的这次请求才会写 token / mailbox（以本次 secret_hash 为凭）。
    // 邮箱唯一由 provision_requests 唯一索引和 mailboxes 主键兜底，冲突时整体回滚。
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare("UPDATE provision_requests SET status='approved', email=?, secret_hash=? WHERE id=? AND status='pending'")
          .bind(email, secretHash, id),
        env.DB.prepare("INSERT INTO agent_tokens (token_hash, email, request_id) SELECT secret_hash, email, id FROM provision_requests WHERE id=? AND status='approved' AND secret_hash=?")
          .bind(id, secretHash),
        env.DB.prepare("INSERT INTO mailboxes (email, request_id) SELECT email, id FROM provision_requests WHERE id=? AND status='approved' AND secret_hash=?")
          .bind(id, secretHash),
      ]);
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String(e && e.message))) {
        return Response.json({ ok: false, error: "email_taken", message: "该邮箱已分配" }, { status: 409 });
      }
      throw e;
    }
    if (results[0].meta.changes !== 1) {
      return Response.json({ ok: false, error: "not_pending", message: "该申请已被处理" }, { status: 409 });
    }
    return Response.json({ ok: true, email, secret });
  }

  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
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

    // MCP 受保护资源元数据（RFC 9728，供 MCP 客户端发现鉴权配置）
    if (path === "/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: url.origin + "/mcp",
        authorization_servers: [url.origin],
        bearer_methods_supported: ["header"],
        resource_name: "aBot Gateway",
      });
    }

    // DCR：动态客户端注册
    if (path === "/oauth/register" && request.method === "POST") {
      try {
        await ensureOAuthTables(env);
      } catch (e) {
        return Response.json({ error: "db_error" }, { status: 500 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_request", detail: "body must be JSON" }, { status: 400 });
      }
      const redirectUris = body.redirect_uris || [];
      if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
        return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
      }
      for (const u of redirectUris) {
        if (typeof u !== "string" || u.length > 2000) {
          return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
        }
        let parsed;
        try { parsed = new URL(u); } catch {
          return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
        }
        const isHttps = parsed.protocol === "https:";
        const isLocalhost = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
        if (!isHttps && !isLocalhost) {
          return Response.json({ error: "invalid_redirect_uri", detail: "redirect_uri must be https (or http://localhost)" }, { status: 400 });
        }
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
<p>客户端 <code>${esc(clientId)}</code> 请求访问你的 aBot 服务。</p>
<p style="color:#666">请输入你的 agent 邮箱和 Secret（在 admin 页获取）。</p>
<form method="POST">
<input type="hidden" name="client_id" value="${esc(clientId)}">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
<input type="hidden" name="state" value="${esc(state)}">
<input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
<input type="email" name="email" placeholder="agent@abot.run" required>
<input type="password" name="secret" placeholder="ask_..." required>
<button type="submit">登录并授权</button>
</form></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        // 参数以 form 为准（query 兜底），重新校验防篡改
        const fClientId = (form.get("client_id") || clientId).toString();
        const fRedirectUri = (form.get("redirect_uri") || redirectUri).toString();
        const fState = (form.get("state") || state).toString();
        const fCodeChallenge = (form.get("code_challenge") || codeChallenge).toString();
        const fClient = await env.DB.prepare("SELECT * FROM gw_oauth_clients WHERE client_id=?")
          .bind(fClientId).first();
        const fAllowed = fClient ? JSON.parse(fClient.redirect_uris || "[]") : [];
        if (!fClient || !fAllowed.includes(fRedirectUri)) {
          return new Response("invalid client_id or redirect_uri", { status: 400 });
        }
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
        ).bind(code, fClientId, fRedirectUri, fCodeChallenge || null, expiresAt, email).run();
        const dest = new URL(fRedirectUri);
        dest.searchParams.set("code", code);
        if (fState) dest.searchParams.set("state", fState);
        return Response.redirect(dest.toString(), 302);
      }
    }

    // Token 交换
    if (path === "/oauth/token" && request.method === "POST") {
      await ensureOAuthTables(env);
      let form;
      try { form = await request.formData(); } catch {
        return Response.json({
          error: "invalid_request",
          message: "请用表单格式（application/x-www-form-urlencoded）提交，不是 JSON。字段：grant_type=password、username=<邮箱>、password=<secret>",
        }, { status: 400 });
      }
      const grantType = form.get("grant_type");
      // password grant：邮箱+secret 换 token（给 agent 用）
      if (grantType === "password") {
        const username = (form.get("username") || "").trim().toLowerCase();
        const password = (form.get("password") || "").trim();
        if (!username || !password) {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        const hash = await sha256hex(password);
        // 与 /oauth/authorize 同一凭证来源：吊销或换 Secret 后旧 secret 立即失效
        const row = await env.DB.prepare(
          "SELECT email FROM agent_tokens WHERE token_hash=? AND email=? AND revoked_at IS NULL"
        ).bind(hash, username).first();
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
      const token = "abot_" + [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare("INSERT INTO gw_oauth_tokens (token, email, created_at) VALUES (?,?,?)")
        .bind(token, row.email || null, Date.now()).run();
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 31536000 });
    }

    // ---- Provision：新 agent 申请身份（需人工审核） ----

    // 申请说明（agent 自助读取；浏览器访问返回 HTML）。admin.abot.run 的 / 是管理页，不在这里处理
    const isSignupInfo = path === "/signup" || path === "/provision/info" || (path === "/" && url.hostname !== ADMIN_HOST);
    if (isSignupInfo && request.method === "GET") {
      return signupPage(request);
    }

    if ((path === "/provision/request" || path === "/signup") && request.method === "POST") {
      await ensureOAuthTables(env);
      let body;
      try { body = await request.json(); } catch { body = {}; }
      if (!body || typeof body !== "object") body = {};
      // 邀请码必填，一次性
      const inviteCode = (typeof body.invite_code === "string" ? body.invite_code : "").trim();
      if (!inviteCode) {
        return Response.json({ error: "invite_code_required", message: "需要邀请码才能申请" }, { status: 400 });
      }
      // 填了就必须合法（与审批用同一个 EMAIL_RE），在占用邀请码之前拒绝
      const rawEmail = typeof body.requested_email === "string" ? body.requested_email.trim() : "";
      const requestedEmail = rawEmail ? normalizeEmail(rawEmail) : null;
      if (rawEmail && !requestedEmail) {
        return Response.json({ error: "invalid_email", message: "邮箱必须是 xxx@abot.run，只含小写字母、数字、._-" }, { status: 400 });
      }
      const codeHash = await sha256hex(inviteCode);
      const id = newId("prov");
      const text = (v) => (v == null ? null : String(v).slice(0, 2000));
      // 先原子占用邀请码（未用、1 小时内、全局最近 1 小时申请不足 10 个），占用成功才插入申请。
      // 两条语句在同一事务里；插入以 used_by=本次 id 为条件。
      const [claim] = await env.DB.batch([
        env.DB.prepare(
          `UPDATE invite_codes SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), used_by=?, code=NULL
           WHERE code_hash=? AND used_at IS NULL AND ${isoTime("created_at")} > ${HOUR_AGO}
             AND (SELECT COUNT(*) FROM provision_requests WHERE ${isoTime("created_at")} > ${HOUR_AGO}) < 10`
        ).bind(id, codeHash),
        env.DB.prepare(
          "INSERT INTO provision_requests (id, agent_name, reason, requested_email, status) SELECT ?, ?, ?, ?, 'pending' FROM invite_codes WHERE code_hash=? AND used_by=?"
        ).bind(id, text(body.agent_name), text(body.reason), requestedEmail, codeHash, id),
      ]);
      if (claim.meta.changes === 1) {
        return Response.json({ id, status: "pending", message: "等待人工审核" });
      }
      const codeRow = await env.DB.prepare(
        `SELECT used_at, ${isoTime("created_at")} > ${HOUR_AGO} AS fresh FROM invite_codes WHERE code_hash=?`
      ).bind(codeHash).first();
      if (!codeRow) {
        return Response.json({ error: "invalid_invite_code" }, { status: 403 });
      }
      if (codeRow.used_at) {
        return Response.json({ error: "invite_code_used" }, { status: 403 });
      }
      if (!codeRow.fresh) {
        return Response.json({ error: "invite_code_expired", message: "邀请码已过期（1小时有效）" }, { status: 403 });
      }
      return Response.json({ error: "rate_limited" }, { status: 429 });
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

    // 管理页只在 admin.abot.run 提供：Cloudflare Access 在边缘拦截，代码内再校验 Access JWT（纵深防御）
    const isAdminHost = url.hostname === ADMIN_HOST;
    if (!isAdminHost && (path === "/admin" || path.startsWith("/admin/"))) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (isAdminHost && ADMIN_POST_PATHS.includes(path) && request.method === "POST") {
      const denied = await requireAccess(request);
      if (denied) return denied;
      const csrf = rejectCrossSite(request);
      if (csrf) return csrf;
      let body;
      try { body = await request.json(); } catch { body = null; }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }
      let resp;
      try {
        await ensureOAuthTables(env);
        resp = await handleAdminPost(path, body, env);
      } catch (e) {
        resp = internalError();
      }
      resp.headers.set("Cache-Control", "no-store");
      return resp;
    }
    if (isAdminHost && (path === "/" || path === "") && request.method === "GET") {
      const denied = await requireAccess(request);
      if (denied) return denied;
      try {
        await ensureOAuthTables(env);
        const rows = await env.DB.prepare(
          "SELECT id, agent_name, reason, requested_email, status, email, created_at FROM provision_requests ORDER BY created_at DESC LIMIT 50"
        ).all();
        // 有效邀请码（未使用、1小时内、有明文）
        const codes = await env.DB.prepare(
          `SELECT code, created_at FROM invite_codes WHERE used_at IS NULL AND code IS NOT NULL AND ${isoTime("created_at")} > ${HOUR_AGO} ORDER BY created_at DESC`
        ).all();
        const codeItems = (codes.results || []).map((c, i) =>
          `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
            <code id="vc${i}" style="flex:1">${esc(c.code)}</code>
            <button data-action="copy" data-target="vc${i}" style="padding:4px 12px;font-size:12px">复制</button>
            <span style="color:#999;font-size:12px">${esc(c.created_at)}</span>
          </div>`
        ).join("");
        // 已批准的 agent 列表
        const agents = await env.DB.prepare(
          "SELECT id, agent_name, email, created_at FROM provision_requests WHERE status='approved' AND email IS NOT NULL ORDER BY created_at DESC"
        ).all();
        const agentItems = (agents.results || []).map((a, i) =>
          `<div class="agent-row" style="display:flex;align-items:center;gap:8px;margin:6px 0;padding:8px;border:1px solid #ddd;border-radius:6px">
            <div style="flex:1"><b>${esc(a.agent_name) || "(未命名)"}</b><br><code>${esc(a.email)}</code></div>
            <button data-action="rotate" data-id="${esc(a.id)}" style="padding:4px 12px;font-size:12px">换 Secret</button>
            <button data-action="revoke" data-id="${esc(a.id)}" style="padding:4px 12px;font-size:12px;background:#ffebee">吊销</button>
          </div>`
        ).join("");
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        const items = (rows.results || []).map((r) =>
          `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:8px 0">
            <b>${esc(r.agent_name) || "(未命名)"}</b> <span style="color:#666">${esc(r.id)}</span><br>
            <span>${esc(r.reason)}</span><br>
            <span>状态: ${esc(STATUS_LABELS[r.status] || r.status)}</span> <span style="color:#999">${esc(r.created_at)}</span><br>
            ${r.status === "approved" && r.email ? `<span style="color:#2e7d32">邮箱: ${esc(r.email)}</span><br>` : ""}
            ${r.status === "revoked" && r.email ? `<span style="color:#c62828">邮箱: ${esc(r.email)}（已吊销）</span><br>` : ""}
            ${r.status === "pending" ? `
              <div class="req-row" style="margin-top:8px">
                ${r.requested_email ? `<span style="color:#666">申请想要：${esc(r.requested_email)}</span><br>` : ""}
                <button data-action="approve" data-id="${esc(r.id)}">通过并建邮箱</button>
                <button data-action="deny" data-id="${esc(r.id)}">拒绝</button>
              </div>` : ""}
          </div>`
        ).join("");
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>aBot 审核</title><script nonce="${nonce}">${ADMIN_JS}</script>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px}
button{padding:8px 20px;margin:4px;font-size:14px;cursor:pointer}
.newcode{background:#e8f5e9;border:1px solid #4caf50;border-radius:8px;padding:12px;margin:12px 0;word-break:break-all}</style>
</head><body><h2>aBot 新 Agent 审核</h2>
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
          { headers: adminPageHeaders(nonce) });
      } catch (e) {
        return internalError();
      }
    }

    // ---- 以下为 MCP 代理（需鉴权） ----

    // 对外鉴权：OAuth token(abot_)，必须绑定邮箱
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let agentEmail = null;
    if (token.startsWith("abot_")) {
      await ensureOAuthTables(env);
      const row = await env.DB.prepare("SELECT email, created_at FROM gw_oauth_tokens WHERE token=?").bind(token).first();
      if (row && row.email && row.created_at > Date.now() - 365 * 24 * 3600 * 1000) {
        agentEmail = row.email;
      }
    }
    if (!agentEmail) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer resource_metadata="https://abot.run/.well-known/oauth-protected-resource", error="invalid_token"',
        },
      });
    }

    // ---- 统一 MCP 网关：POST /mcp ----
    if (path === "/mcp" && request.method === "POST") {
      if (!agentEmail) {
        return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "agent email not bound" } }, { status: 401 });
      }
      try {
        const rpc = await request.json();
        const method = rpc.method;
        const rpcId = rpc.id;
        
        // MCP 服务注册表
        const MCP_SERVICES = [
          { prefix: "mail", binding: ROUTES["/mail/"] },
          { prefix: "data", binding: ROUTES["/data/"] },
          { prefix: "health", binding: ROUTES["/health/"] },
          { prefix: "rules", binding: ROUTES["/rules/"] },
          { prefix: "secrets", binding: ROUTES["/secrets/"] },
          { prefix: "sms", binding: ROUTES["/sms/"] },
        ];
        
        async function callBackend(svc, rpcPayload, timeoutMs) {
          const binding = serviceBinding(env, svc.binding);
          if (!binding) {
            const err = new Error("binding_not_configured");
            err.code = "BINDING_NOT_CONFIGURED";
            err.binding = svc.binding;
            throw err;
          }
          const headers = {
            "Content-Type": "application/json",
            "X-Abot-Owner-Email": agentEmail,
          };
          const resp = await binding.fetch("https://backend.internal/mcp", {
            method: "POST",
            headers,
            body: JSON.stringify(rpcPayload),
            signal: AbortSignal.timeout(timeoutMs || 15000),
          });
          if (!resp.ok) {
            try { await resp.body?.cancel(); } catch {}
            throw new Error("backend_unavailable");
          }
          try {
            return await resp.json();
          } catch {
            throw new Error("backend_unavailable");
          }
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
          // 并行拉取，单个失败不影响其他（12s 超时）
          const settled = await Promise.allSettled(
            MCP_SERVICES.map((svc) =>
              callBackend(svc, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 12000)
                .then((r) => ({ svc, tools: (r.result && r.result.tools) || [] }))
            )
          );
          const allTools = [];
          for (const s of settled) {
            if (s.status !== "fulfilled") continue;
            for (const t of s.value.tools) {
              allTools.push({
                name: s.value.svc.prefix + "_" + t.name,
                description: "[" + s.value.svc.prefix + "] " + (t.description || ""),
                inputSchema: t.inputSchema,
              });
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
          let r;
          try {
            r = await callBackend(svc, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: realName, arguments: args } }, 30000);
          } catch (e) {
            const missing = e && e.code === "BINDING_NOT_CONFIGURED";
            return Response.json({
              jsonrpc: "2.0",
              id: rpcId,
              error: {
                code: -32603,
                message: missing
                  ? "backend unavailable: " + prefix + " (service binding " + e.binding + " is not configured)"
                  : "backend unavailable: " + prefix,
              },
            }, { status: 502 });
          }
          // 透传后端的 result/error
          if (r.error) {
            return Response.json({ jsonrpc: "2.0", id: rpcId, error: r.error });
          }
          return Response.json({ jsonrpc: "2.0", id: rpcId, result: r.result });
        }
        
        return Response.json({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "method not found: " + method } });
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id: (typeof rpcId !== "undefined" ? rpcId : null), error: { code: -32603, message: "internal error" } }, { status: 500 });
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
      return Response.json({ error: "unknown service, use /data/, /mail/, /health/, /rules/, /secrets/, /sms/" }, { status: 404 });
    }

    const bindingName = route;
    const serviceName = routeServiceName(prefix);
    const binding = serviceBinding(env, bindingName);
    if (!binding) {
      return backendUnavailable(serviceName, "service binding " + bindingName + " is not configured");
    }

    // 去掉网关前缀。Service Binding 按 binding 路由，hostname 不走公网。
    const rest = path.slice(prefix.length);
    const targetUrl = "https://backend.internal/" + rest + url.search;

    const headers = new Headers(request.headers);
    headers.delete("X-Internal-Token");
    // agent 身份透传（后端信任此头做隔离）
    headers.set("X-Abot-Owner-Email", agentEmail);
    headers.delete("Authorization");

    let resp;
    try {
      resp = await binding.fetch(targetUrl, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer(),
      });
    } catch {
      return backendUnavailable(serviceName);
    }

    if (resp.status >= 500) {
      try { await resp.body?.cancel(); } catch {}
      return backendUnavailable(serviceName);
    }

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

