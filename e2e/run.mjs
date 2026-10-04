// 本地 e2e：wrangler dev + 6 个 mock 后端。
// 不部署到 Cloudflare。需要人工在 Cloudflare 上做的步骤见 e2e/README.md。
//
// 人工步骤（本脚本不会做）：
// 1. 部署网关到 staging
// 2. 把 BACKEND_DATA/MAIL/HEALTH/RULES/SECRETS 绑到真实 Worker
// 3. 确认真实后端不再强制校验 X-Internal-Token
// 4. 用 Cloudflare Access 审核出真实 agent secret（这里只往本地 D1 插夹具）
// 5. 用真实 token 对 staging 再打一遍六条路由
// 6. 不要对生产后端注入 500；/__e2e_fail 只存在于本地 mock

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = path.join(root, "e2e");
const stateDir = path.join(e2eDir, ".state");
const logDir = path.join(e2eDir, ".logs");
const registryDir = path.join(stateDir, "registry");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");
const gatewayConfig = path.join(e2eDir, "wrangler.gateway.toml");

const BASE = "http://127.0.0.1:8787";
const EMAIL = "e2e-agent@abot.run";
const SECRET = "ask_e2e_local_only";
const REDIRECT = "http://localhost/callback";

const BACKENDS = [
  { name: "abot-data", config: "wrangler.data.toml", port: 8781, inspector: 9231, route: "/data/v1/items?q=e2e", path: "/v1/items", search: "?q=e2e" },
  { name: "resend-agent-mail-relay", config: "wrangler.mail.toml", port: 8782, inspector: 9232, route: "/mail/inbox?box=INBOX", path: "/inbox", search: "?box=INBOX" },
  { name: "abot-health", config: "wrangler.health.toml", port: 8783, inspector: 9233, route: "/health/status", path: "/status", search: "" },
  { name: "abot-rules", config: "wrangler.rules.toml", port: 8784, inspector: 9234, route: "/rules/list", path: "/list", search: "" },
  { name: "abot-secrets", config: "wrangler.secrets.toml", port: 8785, inspector: 9235, route: "/secrets/names", path: "/names", search: "" },
  { name: "abot-sms", config: "wrangler.sms.toml", port: 8786, inspector: 9236, route: "/sms/status", path: "/status", search: "" },
];

const children = [];
const report = [];
let failed = 0;

const childEnv = {
  ...process.env,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_REGISTRY_PATH: registryDir,
  FORCE_COLOR: "0",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secretHash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function startWorker(name, args) {
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, name + ".log");
  const log = createWriteStream(logPath);
  const child = spawn(wrangler, args, {
    cwd: root,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (code) => {
    log.write("\n[exit " + code + "]\n");
  });
  children.push(child);
  return { child, logPath };
}

function stopAll() {
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}

async function forceStop() {
  stopAll();
  await sleep(800);
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

function record(step, request, response, checks) {
  const ok = checks.every((c) => c.ok);
  if (!ok) failed += 1;
  report.push({ step, request, response, checks, ok });
  console.log("\n=== " + step + " ===");
  console.log("REQUEST");
  console.log(request.method + " " + request.url);
  if (request.headers) console.log(formatHeaders(request.headers));
  if (request.body !== undefined) console.log("body: " + request.body);
  console.log("RESPONSE");
  console.log("HTTP " + response.status);
  if (response.headers) console.log(formatHeaders(response.headers));
  console.log(response.body);
  for (const check of checks) {
    console.log((check.ok ? "PASS" : "FAIL") + "  " + check.name);
  }
}

function formatHeaders(headers) {
  const lines = [];
  const h = headers instanceof Headers ? headers : new Headers(headers);
  for (const [k, v] of h.entries()) lines.push(k + ": " + v);
  return lines.join("\n");
}

async function http(url, init = {}) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000), ...init });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text };
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status > 0) {
        await response.arrayBuffer().catch(() => {});
        return;
      }
    } catch (e) {
      last = e && e.message ? e.message : String(e);
    }
    await sleep(400);
  }
  throw new Error("timed out waiting for " + url + (last ? " (" + last + ")" : ""));
}

function d1Args(extra) {
  return [
    "d1", "execute", "abot-gateway-e2e",
    "--local",
    "--persist-to", stateDir,
    "-c", gatewayConfig,
    "-y",
    ...extra,
  ];
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (buf) => { out += buf; });
    child.stderr.on("data", (buf) => { out += buf; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error("wrangler " + args.join(" ") + " exited " + code + "\n" + out));
    });
  });
}

async function seedAgent() {
  const hash = secretHash(SECRET);
  const sql = [
    "CREATE TABLE IF NOT EXISTS agent_tokens (",
    "  token_hash TEXT PRIMARY KEY,",
    "  email TEXT NOT NULL,",
    "  request_id TEXT,",
    "  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),",
    "  revoked_at TEXT",
    ");",
    "DELETE FROM agent_tokens WHERE email = '" + EMAIL + "';",
    "INSERT INTO agent_tokens (token_hash, email, request_id) VALUES ('" + hash + "', '" + EMAIL + "', 'e2e');",
  ].join("\n");
  const file = path.join(stateDir, "seed.sql");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, sql);
  const out = await runWrangler(d1Args(["--file", file]));
  return { hash, out };
}

function assertJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(registryDir, { recursive: true });

  console.log("本地 e2e：wrangler dev + mock 后端。没有访问 Cloudflare，也没有部署。");
  console.log("夹具身份: " + EMAIL + " / " + SECRET);

  const seeded = await seedAgent();
  record("0. 写入本地 D1 夹具（不是 HTTP 请求）", {
    method: "SQL",
    url: "local D1 abot-gateway-e2e",
    body: "INSERT agent_tokens email=" + EMAIL + " sha256=" + seeded.hash,
  }, {
    status: 0,
    body: seeded.out.trim(),
  }, [{ name: "本地 seed 命令成功", ok: true }]);

  for (const backend of BACKENDS) {
    startWorker(backend.name, [
      "dev", "-c", path.join(e2eDir, backend.config),
      "--local", "--ip", "127.0.0.1",
      "--port", String(backend.port),
      "--inspector-port", String(backend.inspector),
      "--show-interactive-dev-session=false",
      "--log-level", "info",
    ]);
  }
  await Promise.all(BACKENDS.map((backend) => waitForHttp("http://127.0.0.1:" + backend.port + "/", 90000)));

  startWorker("abot-gateway", [
    "dev", "-c", gatewayConfig,
    "--local", "--ip", "127.0.0.1",
    "--port", "8787",
    "--inspector-port", "9237",
    "--persist-to", stateDir,
    "--show-interactive-dev-session=false",
    "--log-level", "info",
  ]);
  await waitForHttp(BASE + "/health", 90000);

  const health = await http(BASE + "/health");
  const healthBody = assertJson(health.body);
  record("1. 网关自身 /health（不转发）", {
    method: "GET",
    url: BASE + "/health",
  }, health, [{
    name: "200 且 service=abot-gateway",
    ok: health.status === 200 && healthBody && healthBody.service === "abot-gateway",
  }]);

  const unauth = await http(BASE + "/data/v1/items");
  record("2. 未带 token 访问 /data/", {
    method: "GET",
    url: BASE + "/data/v1/items",
  }, unauth, [{ name: "401", ok: unauth.status === 401 }]);

  const registered = await http(BASE + "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  });
  const registeredBody = assertJson(registered.body);
  const clientId = registeredBody && registeredBody.client_id;
  record("3. POST /oauth/register", {
    method: "POST",
    url: BASE + "/oauth/register",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
  }, registered, [{
    name: "200 且返回 client_id",
    ok: registered.status === 200 && typeof clientId === "string" && clientId.startsWith("cli_"),
  }]);
  if (!clientId) throw new Error("register failed");

  const authorizeUrl = new URL(BASE + "/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT);
  authorizeUrl.searchParams.set("state", "e2e");
  const authorizeBody = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "e2e",
    code_challenge: "",
    email: EMAIL,
    secret: SECRET,
  });
  const authorized = await http(authorizeUrl, { method: "POST", body: authorizeBody });
  const location = authorized.headers.get("location") || "";
  let code = "";
  try { code = new URL(location).searchParams.get("code") || ""; } catch {}
  record("4. POST /oauth/authorize（授权码）", {
    method: "POST",
    url: authorizeUrl.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizeBody.toString(),
  }, {
    status: authorized.status,
    headers: authorized.headers,
    body: location ? "location: " + location : authorized.body,
  }, [
    { name: "302", ok: authorized.status === 302 },
    { name: "redirect 带 code 和 state=e2e", ok: code.startsWith("code_") && location.includes("state=e2e") },
  ]);
  if (!code) throw new Error("authorize failed");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
  });
  const tokenRes = await http(BASE + "/oauth/token", { method: "POST", body: tokenBody });
  const tokenJson = assertJson(tokenRes.body);
  const accessToken = tokenJson && tokenJson.access_token;
  record("5. POST /oauth/token", {
    method: "POST",
    url: BASE + "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  }, tokenRes, [{
    name: "200 且 access_token 以 abot_ 开头",
    ok: tokenRes.status === 200 && typeof accessToken === "string" && accessToken.startsWith("abot_"),
  }]);
  if (!accessToken) throw new Error("token exchange failed");

  const authHeaders = {
    authorization: "Bearer " + accessToken,
    "x-internal-token": "spoofed-token",
  };

  for (const backend of BACKENDS) {
    const url = BASE + backend.route;
    const res = await http(url, { headers: authHeaders });
    const body = assertJson(res.body);
    record("6. GET " + backend.route, {
      method: "GET",
      url,
      headers: authHeaders,
    }, res, [
      { name: "HTTP 200", ok: res.status === 200 },
      { name: "mock service=" + backend.name, ok: !!body && body.service === backend.name && body.ok === true },
      { name: "路径转发为 " + backend.path + backend.search, ok: !!body && body.path === backend.path && body.search === backend.search },
      { name: "带上 X-Abot-Owner-Email", ok: !!body && body.owner === EMAIL },
      { name: "没有转发 X-Internal-Token / Authorization", ok: !!body && body.internalToken === null && body.authorization === null },
    ]);
  }

  const postUrl = BASE + "/data/v1/items";
  const postPayload = JSON.stringify({ ping: true });
  const posted = await http(postUrl, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: postPayload,
  });
  const postedBody = assertJson(posted.body);
  record("7. POST /data/v1/items", {
    method: "POST",
    url: postUrl,
    headers: { ...authHeaders, "content-type": "application/json" },
    body: postPayload,
  }, posted, [
    { name: "HTTP 200", ok: posted.status === 200 },
    { name: "方法与正文原样转发到 abot-data", ok: !!postedBody && postedBody.method === "POST" && postedBody.body === postPayload && postedBody.path === "/v1/items" },
  ]);

  const directFail = await http("http://127.0.0.1:8783/__e2e_fail");
  record("8. 直接打 mock abot-health /__e2e_fail（对照，不经过网关）", {
    method: "GET",
    url: "http://127.0.0.1:8783/__e2e_fail",
  }, directFail, [
    { name: "mock 自己返回 500", ok: directFail.status === 500 },
    { name: "正文里有 workers.dev 地址", ok: directFail.body.includes("abot-health.boliam.workers.dev") },
  ]);

  const proxiedFail = await http(BASE + "/health/__e2e_fail", { headers: authHeaders });
  const leakNeedles = ["workers.dev", "boliam", "10.8.0.4", "upstream_down", "abot-health"];
  const headerText = formatHeaders(proxiedFail.headers);
  const leaked = leakNeedles.filter((needle) => proxiedFail.body.includes(needle) || headerText.includes(needle));
  const proxiedJson = assertJson(proxiedFail.body);
  record("9. GET /health/__e2e_fail（后端 500，经网关）", {
    method: "GET",
    url: BASE + "/health/__e2e_fail",
    headers: authHeaders,
  }, proxiedFail, [
    { name: "HTTP 502", ok: proxiedFail.status === 502 },
    { name: 'body 为 {"error":"backend_unavailable","service":"health"}', ok: !!proxiedJson && proxiedJson.error === "backend_unavailable" && proxiedJson.service === "health" && proxiedJson.detail === undefined },
    { name: "响应不包含后端地址或 500 原文", ok: leaked.length === 0 },
    { name: "没有透传 X-Backend-Host", ok: !proxiedFail.headers.has("x-backend-host") },
  ]);
  if (leaked.length) console.log("泄漏片段: " + leaked.join(", "));

  console.log("\n=== 汇总 ===");
  console.log(report.filter((item) => item.ok).length + "/" + report.length + " 步通过");
  if (failed) {
    console.log(failed + " 步失败。wrangler 日志在 e2e/.logs/");
    process.exitCode = 1;
  } else {
    console.log("本地 e2e 通过。这不能代替 Cloudflare 上的真实验证，见 e2e/README.md。");
  }
}

process.on("SIGINT", () => { stopAll(); process.exit(1); });
process.on("SIGTERM", () => { stopAll(); process.exit(1); });

try {
  await main();
} catch (e) {
  failed += 1;
  console.error("\n中断: " + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  await forceStop();
}
