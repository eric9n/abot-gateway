// 基础测试：验证 worker.js 语法、关键逻辑，以及 Service Binding 代理行为
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import worker from '../src/worker.js';

console.log('1. 检查 worker.js 语法...');
try {
  execSync('node --check src/worker.js', { stdio: 'pipe' });
  console.log('   ✓ worker.js 语法通过');
} catch (e) {
  console.error('   ✗ worker.js 语法错误');
  process.exit(1);
}

console.log('2. 检查 admin.js 语法...');
try {
  execSync('node --check src/admin.js', { stdio: 'pipe' });
  console.log('   ✓ admin.js 语法通过');
} catch (e) {
  console.error('   ✗ admin.js 语法错误');
  process.exit(1);
}

console.log('3. 检查占位符...');
const workerSrc = readFileSync('src/worker.js', 'utf8');
if (!workerSrc.includes('/*__ADMIN_JS__*/')) {
  console.error('   ✗ 缺少 /*__ADMIN_JS__*/ 占位符');
  process.exit(1);
}
console.log('   ✓ 占位符存在');

console.log('3b. 构建后 admin.js 必须嵌进页面...');
{
  execSync('node build.js', { stdio: 'pipe' });
  const dist = readFileSync('dist/worker.js', 'utf8');
  if (dist.includes('/*__ADMIN_JS__*/') || dist.includes('admin.js 未嵌入')) {
    console.error('   ✗ dist 仍是未构建的 admin 占位');
    process.exit(1);
  }
  if (!dist.includes("postJSON('/invite'") || !dist.includes('data-action="invite"')) {
    console.error('   ✗ dist 缺少生成邀请码的脚本');
    process.exit(1);
  }
  console.log('   ✓ admin.js 已嵌入');
}

console.log('4. 检查关键路由...');
const routes = ['/mcp', '/oauth/authorize', '/oauth/token', '/oauth/register', '/admin'];
for (const r of routes) {
  if (!workerSrc.includes(`"${r}"`) && !workerSrc.includes(`'${r}'`)) {
    console.error(`   ✗ 缺少路由 ${r}`);
    process.exit(1);
  }
}
console.log('   ✓ 所有关键路由存在');

console.log('5. 检查安全硬编码...');
const checks = [
  ['esc(', 'HTML 转义函数'],
  ['Cf-Access-Jwt-Assertion', 'Access JWT 校验'],
  ['AbortSignal.timeout', '后端超时'],
  ['Promise.allSettled', 'tools/list 并行'],
  ['oauth-protected-resource', '受保护资源元数据'],
  ['WWW-Authenticate', '401 质询头'],
  ['crypto.getRandomValues', '安全随机数'],
];
for (const [s, name] of checks) {
  if (!workerSrc.includes(s)) { console.error(`   ✗ 缺少 ${name}`); process.exit(1); }
}
console.log('   ✓ 安全项齐全');

console.log('6. 检查无危险模式...');
const bad = [
  ['Math.random().toString(36)', 'Math.random 生成凭证'],
  ['/debug/db', '调试端点'],
  ['String(e.message || e)', '错误泄漏'],
  ['GATEWAY_TOKEN', '已删除的静态 token'],
  ['workers.dev', '公网 workers.dev 后端地址'],
  ['token_env', '内部 token 环境变量映射'],
  ['INTERNAL_DATA', '内部 token secret'],
  ['INTERNAL_MAIL', '内部 token secret'],
  ['INTERNAL_HEALTH', '内部 token secret'],
  ['INTERNAL_RULES', '内部 token secret'],
  ['INTERNAL_SECRETS', '内部 token secret'],
  ['set("X-Internal-Token"', '设置内部 token 头'],
  ["set('X-Internal-Token'", '设置内部 token 头'],
];
for (const [s, name] of bad) {
  if (workerSrc.includes(s)) { console.error(`   ✗ 发现 ${name}: ${s}`); process.exit(1); }
}
console.log('   ✓ 无危险模式');

console.log('7. 检查 Service Binding...');
const bindings = ['BACKEND_DATA', 'BACKEND_MAIL', 'BACKEND_HEALTH', 'BACKEND_RULES', 'BACKEND_SECRETS', 'BACKEND_SMS'];
for (const name of bindings) {
  if (!workerSrc.includes(name)) { console.error(`   ✗ 缺少 binding ${name}`); process.exit(1); }
}
for (const s of ['backend_unavailable', 'X-Abot-Owner-Email', 'serviceBinding(', 'backend.internal']) {
  if (!workerSrc.includes(s)) { console.error(`   ✗ 缺少 ${s}`); process.exit(1); }
}
console.log('   ✓ Service Binding 映射齐全');

console.log('7b. wrangler.toml 与代码一致（部署构建产物、binding、路由）...');
{
  const toml = readFileSync('wrangler.toml', 'utf8');
  const need = [
    'name = "abot-gateway"', 'main = "dist/worker.js"', 'workers_dev = false', 'command = "node build.js"',
    'binding = "DB"', 'database_id = "bb648d2d-e0e6-4d42-87ea-ed2e50cfcc3f"',
    '{ pattern = "admin.abot.run/*", zone_name = "abot.run" }', '{ pattern = "abot.run/*", zone_name = "abot.run" }',
  ];
  for (const n of need) if (!toml.includes(n)) { console.error('   ✗ wrangler.toml 缺少 ' + n); process.exit(1); }
  const routed = [...workerSrc.matchAll(/"\/[a-z]+\/": "(BACKEND_[A-Z]+)"/g)].map((m) => m[1]);
  if (routed.length !== 6) { console.error('   ✗ ROUTES 应有 6 个后端，实际 ' + routed.length); process.exit(1); }
  for (const b of routed) if (!toml.includes(`binding = "${b}"`)) { console.error('   ✗ wrangler.toml 缺少 binding ' + b); process.exit(1); }
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  if (!ci.includes('deploy --config wrangler.toml') || ci.indexOf('node build.js', ci.indexOf('deploy:')) < 0) {
    console.error('   ✗ CI 部署应先构建再用 wrangler.toml'); process.exit(1);
  }
}
console.log('   ✓ wrangler.toml 一致');

function fail(msg) {
  console.error('   ✗ ' + msg);
  process.exit(1);
}

function mockDb() {
  const stmt = {
    bind() { return stmt; },
    async run() { return {}; },
    async first() { return { email: 'agent@abot.run', created_at: Date.now() }; },
    async all() { return { results: [] }; },
  };
  return { prepare() { return stmt; } };
}

function authedRequest(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer abot_testtoken');
  headers.set('X-Internal-Token', 'spoofed-token');
  return new Request('https://abot.run' + path, {
    method: init.method || 'GET',
    headers,
    body: init.body,
  });
}

console.log('8. 直接代理：binding、502、身份头...');
{
  const gatewayHealth = await worker.fetch(new Request('https://abot.run/health'));
  if (gatewayHealth.status !== 200) fail('网关 /health 应免认证');
  const gatewayBody = await gatewayHealth.json();
  if (gatewayBody.service !== 'abot-gateway') fail('网关 /health 被误代理');

  const missing = await worker.fetch(authedRequest('/health/ready'), { DB: mockDb() });
  if (missing.status !== 502) fail('未配置 binding 应返回 502，实际 ' + missing.status);
  const missingBody = await missing.json();
  if (missingBody.error !== 'backend_unavailable' || missingBody.service !== 'health') {
    fail('未配置 binding 的响应体不对: ' + JSON.stringify(missingBody));
  }
  if (!String(missingBody.detail || '').includes('BACKEND_HEALTH')) {
    fail('未配置 binding 应提示 BACKEND_HEALTH');
  }

  let captured = null;
  const originalFetch = globalThis.fetch;
  let publicFetch = 0;
  globalThis.fetch = async (...args) => {
    publicFetch += 1;
    return originalFetch(...args);
  };
  try {
    const ok = await worker.fetch(authedRequest('/data/v1/items?q=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    }), {
      DB: mockDb(),
      BACKEND_DATA: {
        async fetch(url, init) {
          captured = {
            url: String(url),
            method: init.method,
            headers: new Headers(init.headers),
            body: new TextDecoder().decode(init.body),
          };
          return Response.json({ ok: true, n: 1 });
        },
      },
    });
    if (ok.status !== 200) fail('成功代理应透传 200，实际 ' + ok.status);
    const okBody = await ok.json();
    if (!okBody.ok) fail('成功代理应透传正文');
    if (!captured) fail('未调用 binding.fetch');
    if (captured.url !== 'https://backend.internal/v1/items?q=1') fail('目标 URL 不对: ' + captured.url);
    if (captured.method !== 'POST') fail('方法未转发');
    if (captured.body !== '{"n":1}') fail('正文未转发: ' + captured.body);
    if (captured.headers.get('X-Internal-Token')) fail('不应转发 X-Internal-Token');
    if (captured.headers.get('Authorization')) fail('不应转发 Authorization');
    if (captured.headers.get('X-Abot-Owner-Email') !== 'agent@abot.run') fail('缺少身份头');
    if (publicFetch !== 0) fail('后端调用不应走公网 fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const leaked = 'dial tcp 10.1.2.3:443: connection refused token=sekret';
  const down = await worker.fetch(authedRequest('/mail/inbox'), {
    DB: mockDb(),
    BACKEND_MAIL: { async fetch() { throw new Error(leaked); } },
  });
  if (down.status !== 502) fail('后端抛错应返回 502');
  const downText = await down.text();
  if (downText.includes('10.1.2.3') || downText.includes('sekret') || downText.includes('dial tcp')) {
    fail('后端异常泄漏了原文: ' + downText);
  }
  const downBody = JSON.parse(downText);
  if (downBody.error !== 'backend_unavailable' || downBody.service !== 'mail' || downBody.detail) {
    fail('后端抛错应返回通用 502: ' + downText);
  }

  const crashed = await worker.fetch(authedRequest('/rules/list'), {
    DB: mockDb(),
    BACKEND_RULES: {
      async fetch() { return new Response('stack: /opt/secret.key', { status: 500, headers: { 'content-type': 'text/plain' } }); },
    },
  });
  const crashedText = await crashed.text();
  if (crashed.status !== 502 || crashedText.includes('secret.key') || crashedText.includes('stack:')) {
    fail('5xx 不应透传后端原文: ' + crashed.status + ' ' + crashedText);
  }

  const missingItem = await worker.fetch(authedRequest('/secrets/nope'), {
    DB: mockDb(),
    BACKEND_SECRETS: {
      async fetch() { return Response.json({ error: 'not_found' }, { status: 404 }); },
    },
  });
  if (missingItem.status !== 404) fail('4xx 应透传，实际 ' + missingItem.status);
  const missingItemBody = await missingItem.json();
  if (missingItemBody.error !== 'not_found') fail('4xx 正文应透传');
}
console.log('   ✓ 直接代理行为正确');

console.log('9. MCP 聚合：binding、不泄漏后端原文...');
{
  let captured = null;
  const listed = await worker.fetch(authedRequest('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  }), {
    DB: mockDb(),
    BACKEND_DATA: {
      async fetch(url, init) {
        captured = { url: String(url), headers: new Headers(init.headers) };
        return Response.json({ result: { tools: [{ name: 'query', description: 'q', inputSchema: { type: 'object' } }] } });
      },
    },
    BACKEND_MAIL: { async fetch() { throw new Error('mailbox password=hunter2'); } },
  });
  const listedBody = await listed.json();
  const names = (listedBody.result && listedBody.result.tools || []).map((t) => t.name);
  if (!names.includes('data_query')) fail('tools/list 应包含可用后端的工具: ' + JSON.stringify(names));
  if (JSON.stringify(listedBody).includes('hunter2')) fail('tools/list 泄漏了失败后端的原文');
  if (!captured || captured.url !== 'https://backend.internal/mcp') fail('MCP 未走 binding /mcp');
  if (captured.headers.get('X-Internal-Token')) fail('MCP 不应带内部 token');
  if (captured.headers.get('X-Abot-Owner-Email') !== 'agent@abot.run') fail('MCP 缺少身份头');

  const called = await worker.fetch(authedRequest('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'mail_send', arguments: { to: 'a@b.c' } } }),
  }), {
    DB: mockDb(),
    BACKEND_MAIL: {
      async fetch() { return new Response('upstream trace id=abc token rejected', { status: 502 }); },
    },
  });
  const calledText = await called.text();
  if (called.status !== 502) fail('MCP 后端失败应为 502，实际 ' + called.status);
  if (calledText.includes('trace') || calledText.includes('token rejected')) fail('MCP 泄漏后端原文: ' + calledText);
  const calledBody = JSON.parse(calledText);
  if (!calledBody.error || calledBody.error.message !== 'backend unavailable: mail') {
    fail('MCP 失败消息不对: ' + calledText);
  }

  const unbound = await worker.fetch(authedRequest('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'secrets_get', arguments: {} } }),
  }), { DB: mockDb() });
  const unboundBody = await unbound.json();
  if (unbound.status !== 502) fail('MCP binding 缺失应为 502');
  if (!String(unboundBody.error && unboundBody.error.message).includes('BACKEND_SECRETS')) {
    fail('MCP binding 缺失应提示 binding 名: ' + JSON.stringify(unboundBody));
  }
}
console.log('   ✓ MCP 聚合行为正确');

console.log('10. Admin Access JWT 校验 AUD tag...');
{
  const AUD = "20d26cf162fe474df036d3de12e12f893893bd7b031a4b03ec50ce3e4cdbaf99";
  const APP_ID = "05d351ef-e796-4e3e-a6f4-bbcc30b98941";
  if (!workerSrc.includes(`const ACCESS_AUD = "${AUD}"`)) fail("ACCESS_AUD 必须是 Access 应用的 aud tag");
  if (workerSrc.includes(APP_ID)) fail("ACCESS_AUD 不能写成应用 UUID");

  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kid: "test-kid", kty: "RSA", alg: "RS256", use: "sig", e: exported.e, n: exported.n };
  function b64url(bytes) {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  async function signJwt(aud) {
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "JWT" })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: "https://boliam.cloudflareaccess.com",
    })));
    const data = new TextEncoder().encode(header + "." + payload);
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, data));
    return header + "." + payload + "." + b64url(sig);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
    throw new Error("unexpected fetch " + url);
  };
  try {
    const good = await worker.fetch(new Request("https://admin.abot.run/", {
      headers: { "Cf-Access-Jwt-Assertion": await signJwt([AUD]) },
    }), { DB: mockDb() });
    const goodText = await good.text();
    if (good.status !== 200 || !goodText.includes("aBot 新 Agent 审核")) {
      fail("正确 AUD 的 Access JWT 应放行 admin，实际 " + good.status + " " + goodText.slice(0, 180));
    }

    const denied = await worker.fetch(new Request("https://admin.abot.run/", {
      headers: { "Cf-Access-Jwt-Assertion": await signJwt(APP_ID) },
    }), { DB: mockDb() });
    const deniedText = await denied.text();
    if (denied.status !== 403 || deniedText !== "forbidden: invalid Access token") {
      fail("应用 UUID 不应作为 aud 通过: " + denied.status + " " + deniedText);
    }

    const missing = await worker.fetch(new Request("https://admin.abot.run/"));
    const missingText = await missing.text();
    if (missing.status !== 403 || !missingText.includes("Cloudflare Access required")) {
      fail("缺少 JWT 应拒绝: " + missing.status + " " + missingText);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}
console.log('   ✓ Access AUD tag 校验正确');

console.log('11. 行为测试：node:sqlite 模拟 D1，跑构建后的 dist/worker.js...');
const { sqliteD1, accessKeys, ADMIN, AUD: AUD_TAG } = await import('./harness.js');
execSync('node build.js', { stdio: 'pipe' });
const built = (await import('../dist/worker.js?behavior=' + Date.now())).default;
const D1 = sqliteD1();
const env = { DB: D1 };
const ak = await accessKeys();
const J = await ak.sign(ak.claims());
const savedFetch = globalThis.fetch;
globalThis.fetch = ak.fetchMock;

const call = (url, init = {}) => built.fetch(new Request(url, init), env);
const q1 = (sql, ...args) => D1.raw.prepare(sql).get(...args);
function adminPost(path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: ADMIN, ...(opts.headers || {}) };
  if (opts.jwt !== null) headers['Cf-Access-Jwt-Assertion'] = opts.jwt || J;
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  return call((opts.host || ADMIN) + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const adminGet = (opts = {}) => call((opts.host || ADMIN) + (opts.path || '/'), { headers: { 'Cf-Access-Jwt-Assertion': opts.jwt || J } });
// 与 mail.abot.run 的 service binding 调用一致：host 为 abot-gateway，无 Origin
const signup = (code, extra = {}) => call('https://abot-gateway/provision/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ invite_code: code, agent_name: 'bot', reason: 'test', ...extra }),
});
const newCode = async () => (await (await adminPost('/invite', {})).json()).code;
// 全局限流 10 次/小时：造数据前把已有申请挪到窗口外
const ageRequests = () => D1.raw.exec("UPDATE provision_requests SET created_at='2000-01-01T00:00:00.000Z'");
async function newRequest() {
  ageRequests();
  const body = await (await signup(await newCode())).json();
  if (!body.id) fail('造申请失败: ' + JSON.stringify(body));
  return body.id;
}
async function approveNew(email) {
  const id = await newRequest();
  const r = await adminPost('/approve', { id, email });
  return { id, status: r.status, body: await r.json() };
}
function passwordGrant(email, secret) {
  const fd = new FormData();
  fd.set('grant_type', 'password');
  fd.set('username', email);
  fd.set('password', secret);
  return call('https://abot.run/oauth/token', { method: 'POST', body: fd });
}
const client = await (await call('https://abot.run/oauth/register', {
  method: 'POST', body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
})).json();
function authorize(email, secret) {
  const fd = new FormData();
  fd.set('email', email);
  fd.set('secret', secret);
  const qs = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/cb' });
  return call('https://abot.run/oauth/authorize?' + qs, { method: 'POST', body: fd });
}
const mcpInit = (token) => call('https://abot.run/mcp', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
});

try {
  console.log('11a. 吊销后旧 secret 不能再换 token / 授权...');
  {
    const { id, body: ap } = await approveNew('revokeme@abot.run');
    if (!ap.ok || !ap.secret) fail('approve 应返回 secret: ' + JSON.stringify(ap));
    const g = await passwordGrant('revokeme@abot.run', ap.secret);
    if (g.status !== 200) fail('吊销前 password grant 应成功，实际 ' + g.status);
    const { access_token } = await g.json();
    if ((await mcpInit(access_token)).status !== 200) fail('吊销前 token 应可用');
    const a = await authorize('revokeme@abot.run', ap.secret);
    if (a.status !== 302) fail('吊销前 authorize 应 302，实际 ' + a.status);
    if (q1("SELECT COUNT(*) c FROM gw_oauth_codes WHERE email='revokeme@abot.run'").c !== 1) fail('应有一个未用的授权码');

    const rv = await adminPost('/revoke', { id });
    if (rv.status !== 200) fail('吊销应成功，实际 ' + rv.status);
    const row = q1('SELECT status, secret_hash FROM provision_requests WHERE id=?', id);
    if (row.status !== 'revoked' || row.secret_hash !== null) fail('吊销后应 status=revoked 且清空 secret_hash: ' + JSON.stringify(row));
    if ((await passwordGrant('revokeme@abot.run', ap.secret)).status !== 401) fail('吊销后 password grant 必须失败');
    if ((await authorize('revokeme@abot.run', ap.secret)).status !== 401) fail('吊销后 authorize 必须失败');
    if ((await mcpInit(access_token)).status !== 401) fail('吊销后旧 bearer token 必须失效');
    if (q1("SELECT COUNT(*) c FROM gw_oauth_codes WHERE email='revokeme@abot.run'").c !== 0) fail('吊销应删除未用授权码');
    if ((await adminPost('/rotate', { id })).status !== 404) fail('已吊销的申请不能换 Secret');
    const again = await adminPost('/revoke', { id });
    if (again.status !== 409) fail('重复吊销应 409，实际 ' + again.status);

    const html = await (await adminGet()).text();
    const agentsBlock = html.slice(html.indexOf('已接入 Agent'), html.indexOf('</div>\n', html.indexOf('已接入 Agent')) + 1);
    if (agentsBlock.includes('revokeme@abot.run')) fail('已吊销的 agent 不应列在「已接入」');
    if (!html.includes('已吊销')) fail('申请列表应标注已吊销');
  }
  console.log('   ✓ 吊销覆盖 password grant、authorize、bearer token、授权码');

  console.log('11b. 换 Secret 后旧 secret 失效、新 secret 可用...');
  {
    const { id, body: ap } = await approveNew('rotate@abot.run');
    await authorize('rotate@abot.run', ap.secret);
    const rt = await (await adminPost('/rotate', { id })).json();
    if (!rt.ok || !rt.secret || rt.secret === ap.secret) fail('rotate 应返回新 secret');
    if ((await passwordGrant('rotate@abot.run', ap.secret)).status !== 401) fail('换 Secret 后旧 secret 必须失效');
    if ((await passwordGrant('rotate@abot.run', rt.secret)).status !== 200) fail('换 Secret 后新 secret 应可用');
    if (q1("SELECT COUNT(*) c FROM gw_oauth_codes WHERE email='rotate@abot.run'").c !== 0) fail('换 Secret 应删除未用授权码');
    if (q1("SELECT COUNT(*) c FROM agent_tokens WHERE email='rotate@abot.run' AND revoked_at IS NULL").c !== 1) fail('换 Secret 后只应有一个有效 token');
  }
  console.log('   ✓ 换 Secret 行为正确');

  console.log('11c. approve / deny 校验申请存在且为 pending...');
  {
    const ghost = await adminPost('/approve', { id: 'does_not_exist', email: 'ghost@abot.run' });
    const ghostBody = await ghost.json();
    if (ghost.status !== 404 || ghostBody.ok !== false) fail('approve 不存在的申请应 404 ok:false，实际 ' + ghost.status + ' ' + JSON.stringify(ghostBody));
    if (q1("SELECT COUNT(*) c FROM agent_tokens WHERE email='ghost@abot.run'").c !== 0) fail('approve 不存在的申请不应写 agent_tokens');
    if (q1("SELECT COUNT(*) c FROM mailboxes WHERE email='ghost@abot.run'").c !== 0) fail('approve 不存在的申请不应建 mailbox');

    const { id, body: first } = await approveNew('twice@abot.run');
    if (!first.ok) fail('首次 approve 应成功');
    const second = await adminPost('/approve', { id, email: 'twice2@abot.run' });
    if (second.status !== 409) fail('重复 approve 应 409，实际 ' + second.status);
    if (q1("SELECT COUNT(*) c FROM agent_tokens WHERE email='twice2@abot.run'").c !== 0) fail('重复 approve 不应发新凭证');
    if (q1('SELECT email FROM provision_requests WHERE id=?', id).email !== 'twice@abot.run') fail('重复 approve 不应改邮箱');

    const dn = await adminPost('/deny', { id });
    const dnBody = await dn.json();
    if (dn.status !== 409 || dnBody.error !== 'already_approved' || !String(dnBody.message).includes('吊销')) {
      fail('拒绝已通过的申请应 409 并提示用吊销: ' + dn.status + ' ' + JSON.stringify(dnBody));
    }
    if (q1('SELECT status FROM provision_requests WHERE id=?', id).status !== 'approved') fail('deny 不应改已通过的状态');
    if ((await adminPost('/deny', { id: 'nope' })).status !== 404) fail('deny 不存在的申请应 404');

    const pid = await newRequest();
    if ((await adminPost('/deny', { id: pid })).status !== 200) fail('deny pending 应成功');
    if ((await adminPost('/approve', { id: pid, email: 'late@abot.run' })).status !== 409) fail('已拒绝的申请不能再 approve');

    // 同一申请并发 approve：只有一个成功，只发一份凭证
    const rid = await newRequest();
    const rs = await Promise.all([
      adminPost('/approve', { id: rid, email: 'race-a@abot.run' }),
      adminPost('/approve', { id: rid, email: 'race-b@abot.run' }),
    ]);
    if (rs.filter((r) => r.status === 200).length !== 1) fail('并发 approve 应只有一个成功: ' + rs.map((r) => r.status));
    if (q1("SELECT COUNT(*) c FROM agent_tokens WHERE request_id=?", rid).c !== 1) fail('并发 approve 只应写一个 agent_token');
  }
  console.log('   ✓ approve / deny 状态校验正确');

  console.log('11d. 邮箱规范化、格式与唯一性...');
  {
    const bad = ['a@b@abot.run', '@abot.run', 'a b@abot.run', 'x@evil.com,y@abot.run', 'x@evil.com', '.a@abot.run',
      'a.@abot.run', 'a..b@abot.run', 'a@abot.run.evil.com', 'a\nb@abot.run', 'ä@abot.run', 'a+b@abot.run', 'x'.repeat(65) + '@abot.run', 123];
    for (const email of bad) {
      const id = await newRequest();
      const r = await adminPost('/approve', { id, email });
      const b = await r.json();
      if (r.status !== 400 || b.error !== 'invalid_email') fail('非法邮箱应拒绝: ' + JSON.stringify(email) + ' → ' + r.status);
      if (q1('SELECT status FROM provision_requests WHERE id=?', id).status !== 'pending') fail('非法邮箱不应改状态');
    }
    const ok = await approveNew('  Mixed.Case_1-x@ABOT.run ');
    if (!ok.body.ok || ok.body.email !== 'mixed.case_1-x@abot.run') fail('邮箱应 trim + 小写: ' + JSON.stringify(ok.body));

    const taken = await approveNew('MIXED.case_1-x@abot.run');
    if (taken.status !== 409 || taken.body.error !== 'email_taken') fail('重复邮箱应 email_taken: ' + JSON.stringify(taken.body));
    // 已吊销的邮箱也不复用
    const reused = await approveNew('revokeme@abot.run');
    if (reused.body.error !== 'email_taken') fail('已吊销的邮箱不应分配给新申请');

    // 两个申请并发抢同一邮箱：唯一索引兜底，只有一个成功
    const [i1, i2] = [await newRequest(), await newRequest()];
    const rs = await Promise.all([
      adminPost('/approve', { id: i1, email: 'same@abot.run' }),
      adminPost('/approve', { id: i2, email: 'same@abot.run' }),
    ]);
    const bodies = await Promise.all(rs.map((r) => r.json()));
    if (bodies.filter((b) => b.ok).length !== 1 || !bodies.some((b) => b.error === 'email_taken')) {
      fail('并发分配同一邮箱应只有一个成功: ' + JSON.stringify(bodies));
    }
    if (q1("SELECT COUNT(*) c FROM agent_tokens WHERE email='same@abot.run'").c !== 1) fail('同一邮箱只应有一个 token');
    if (q1("SELECT COUNT(*) c FROM provision_requests WHERE email='same@abot.run'").c !== 1) fail('失败的一方应整体回滚');
  }
  console.log('   ✓ 邮箱校验正确');

  console.log('11e. 邀请码一次性（并发）、过期、错误码与 mail 服务契约...');
  {
    const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
    const legacy = (minAgo) => iso(minAgo).replace('T', ' ').slice(0, 19);
    const addCode = async (code, createdAt) => {
      const h = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))).toString('hex');
      D1.raw.prepare('INSERT INTO invite_codes (code_hash, code, created_at) VALUES (?,?,?)').run(h, code, createdAt);
    };
    ageRequests();
    const before = q1('SELECT COUNT(*) c FROM provision_requests').c;
    const code = await newCode();
    const rs = await Promise.all([1, 2, 3, 4].map(() => signup(code).then(async (r) => ({ status: r.status, body: await r.json() }))));
    const won = rs.filter((r) => r.status === 200);
    if (won.length !== 1) fail('同一邀请码并发只能成功一次: ' + JSON.stringify(rs));
    const w = won[0].body;
    if (!w.id || w.status !== 'pending' || !w.message || Object.keys(w).sort().join() !== 'id,message,status') fail('成功响应应为 {id,status:pending,message}: ' + JSON.stringify(w));
    if (rs.filter((r) => r.status === 403 && r.body.error === 'invite_code_used').length !== 3) fail('其余并发请求应 invite_code_used: ' + JSON.stringify(rs));
    if (q1('SELECT COUNT(*) c FROM provision_requests').c !== before + 1) fail('并发后只应多一条申请');
    if (q1('SELECT COUNT(*) c FROM invite_codes WHERE used_at IS NOT NULL AND code IS NOT NULL').c !== 0) fail('用过的邀请码不应保留明文');

    const expect = async (c, status, error, label) => {
      ageRequests();
      const r = await signup(c);
      const b = await r.json();
      if (r.status !== status || (error && b.error !== error)) fail(label + ': 期望 ' + status + ' ' + error + '，实际 ' + r.status + ' ' + JSON.stringify(b));
      return b;
    };
    await expect('', 400, 'invite_code_required', '缺邀请码');
    await expect('inv_nope', 403, 'invalid_invite_code', '不存在的邀请码');
    await addCode('inv_expired_iso', iso(61));
    await expect('inv_expired_iso', 403, 'invite_code_expired', '61 分钟前的邀请码');
    await addCode('inv_legacy_fresh', legacy(30));
    await expect('inv_legacy_fresh', 200, null, '老格式 30 分钟前的邀请码（按 UTC）');
    await addCode('inv_legacy_old', legacy(90));
    await expect('inv_legacy_old', 403, 'invite_code_expired', '老格式 90 分钟前的邀请码');
    const noBody = await call('https://abot-gateway/provision/request', { method: 'POST', body: 'not json' });
    if (noBody.status !== 400 || (await noBody.json()).error !== 'invite_code_required') fail('非 JSON 应按缺邀请码处理');
  }
  console.log('   ✓ 邀请码行为正确');

  console.log('11f. 限流只统计最近 1 小时（ISO 时间比较）...');
  {
    ageRequests();
    const ins = D1.raw.prepare("INSERT INTO provision_requests (id, status, created_at) VALUES (?, 'denied', ?)");
    // 同一天、早于 1 小时的旧行（旧代码用 datetime() 空格格式比较会误计入）
    for (let i = 0; i < 20; i++) ins.run('old_' + i, new Date(Date.now() - (61 + i) * 60000).toISOString());
    for (let i = 0; i < 9; i++) ins.run('new_' + i, new Date(Date.now() - (5 + i) * 60000).toISOString());
    const okCode = await newCode();
    const r1 = await signup(okCode);
    if (r1.status !== 200) fail('窗口内 9 条时第 10 条应放行，实际 ' + r1.status + ' ' + await r1.text());
    const limited = await newCode();
    const r2 = await signup(limited);
    if (r2.status !== 429 || (await r2.json()).error !== 'rate_limited') fail('窗口内满 10 条应 429');
    if (q1("SELECT used_at FROM invite_codes WHERE code=?", limited)?.used_at !== null) fail('被限流时邀请码不应作废');
    ageRequests();
    if ((await signup(limited)).status !== 200) fail('窗口过去后同一邀请码应仍可用');
  }
  console.log('   ✓ 限流窗口正确');

  console.log('11g. admin 页只列未过期、未使用的邀请码...');
  {
    const h = async (c) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c))).toString('hex');
    D1.raw.prepare('INSERT INTO invite_codes (code_hash, code, created_at) VALUES (?,?,?)').run(await h('inv_list_stale'), 'inv_list_stale', new Date(Date.now() - 2 * 3600000).toISOString());
    // 今天 00:00Z 的码在当天 01:00Z 之后已过期；旧代码的字符串比较会把它当成有效
    D1.raw.prepare("INSERT INTO invite_codes (code_hash, code, created_at) VALUES (?, 'inv_list_midnight', strftime('%Y-%m-%dT00:00:00.000Z','now','-1 hour'))").run(await h('inv_list_midnight'));
    const fresh = await newCode();
    const used = await newCode();
    ageRequests();
    await signup(used);
    const html = await (await adminGet()).text();
    if (!html.includes(fresh)) fail('有效邀请码应列出');
    if (html.includes('inv_list_stale') || html.includes('inv_list_midnight')) fail('过期邀请码不应列出');
    if (html.includes(used)) fail('已用邀请码不应列出');
  }
  console.log('   ✓ 邀请码列表正确');

  console.log('11h. 构建：admin.js 原样嵌入页面，特殊字符不破坏模板...');
  {
    const adminSrc = readFileSync('src/admin.js', 'utf8');
    const html = await (await adminGet()).text();
    if (!html.includes(adminSrc)) fail('页面里的脚本应与 src/admin.js 逐字节一致');

    const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    const dir = mkdtempSync(path.join(tmpdir(), 'abot-build-'));
    mkdirSync(path.join(dir, 'src'));
    copyFileSync('build.js', path.join(dir, 'build.js'));
    copyFileSync('src/worker.js', path.join(dir, 'src/worker.js'));
    const tricky = adminSrc + '\nvar t = `${1}` + "\\\\" + \'\\u2028\' + "$&$1"; // 反引号 ` 与 ${x}\n';
    writeFileSync(path.join(dir, 'src/admin.js'), tricky);
    execSync('node build.js', { cwd: dir, stdio: 'pipe' });
    const trickyWorker = (await import(path.join(dir, 'dist/worker.js'))).default;
    const page = await (await trickyWorker.fetch(new Request(ADMIN + '/', { headers: { 'Cf-Access-Jwt-Assertion': J } }), env)).text();
    if (!page.includes(tricky)) fail('含反引号/${/反斜杠的 admin.js 应原样嵌入');

    writeFileSync(path.join(dir, 'src/admin.js'), adminSrc + '\n// </script>\n');
    let rejected = false;
    try { execSync('node build.js', { cwd: dir, stdio: 'pipe' }); } catch { rejected = true; }
    if (!rejected) fail('admin.js 含 </script 时构建应失败');
  }
  console.log('   ✓ 构建嵌入正确');

  console.log('11i. admin 只在 admin.abot.run，POST 需 Access + 同源 JSON...');
  {
    const expect = async (resp, status, label, error) => {
      const text = await resp.text();
      if (resp.status !== status) fail(label + ': 期望 ' + status + '，实际 ' + resp.status + ' ' + text.slice(0, 120));
      if (error && !text.includes(error)) fail(label + ': 期望 ' + error + '，实际 ' + text.slice(0, 120));
    };
    await expect(await adminPost('/invite', {}, { jwt: null }), 403, '无 JWT');
    await expect(await adminPost('/invite', {}, { jwt: await ak.sign(ak.claims({ aud: ['05d351ef-e796-4e3e-a6f4-bbcc30b98941'] })) }), 403, '错误 aud');
    await expect(await adminPost('/invite', '{}', { headers: { 'Content-Type': 'text/plain' } }), 403, 'text/plain', 'csrf_rejected');
    await expect(await adminPost('/invite', '{}', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), 403, '表单类型', 'csrf_rejected');
    await expect(await adminPost('/invite', {}, { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } }), 403, '跨站 Origin', 'csrf_rejected');
    await expect(await adminPost('/invite', {}, { headers: { Origin: 'https://abot.run' } }), 403, 'abot.run Origin', 'csrf_rejected');
    await expect(await adminPost('/invite', {}, { headers: { Origin: 'null' } }), 403, 'Origin null', 'csrf_rejected');
    await expect(await adminPost('/invite', {}, { headers: { Origin: null } }), 403, '无 Origin 无 Sec-Fetch-Site', 'csrf_rejected');
    await expect(await adminPost('/invite', {}, { headers: { Origin: null, 'Sec-Fetch-Site': 'cross-site' } }), 403, '无 Origin 跨站', 'csrf_rejected');
    await expect(await adminPost('/invite', {}, { headers: { Origin: null, 'Sec-Fetch-Site': 'same-origin' } }), 200, '无 Origin 但 same-origin');
    await expect(await adminPost('/invite', {}, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }), 200, '带 charset 的 JSON');
    const pid = await newRequest();
    await expect(await adminPost('/deny', JSON.stringify({ id: pid }), { headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' } }), 403, '跨站 text/plain deny');
    if (q1('SELECT status FROM provision_requests WHERE id=?', pid).status !== 'pending') fail('被拒的 CSRF 请求不应改状态');

    await expect(await adminPost('/approve', '{not json'), 400, '坏 JSON', 'invalid_json');
    await expect(await adminPost('/approve', '[1]'), 400, 'JSON 数组', 'invalid_json');
    const inv = await adminPost('/invite', {});
    if (inv.headers.get('cache-control') !== 'no-store') fail('admin POST 响应应 no-store（含 secret / 邀请码）');

    await expect(await adminGet({ host: 'https://abot.run', path: '/admin' }), 404, 'abot.run/admin 不再是管理页');
    await expect(await adminPost('/admin/invite', {}, { host: 'https://abot.run', headers: { Origin: 'https://abot.run' } }), 404, 'abot.run/admin/invite');
    await expect(await adminGet({ host: 'https://abot-gateway.example.workers.dev', path: '/admin' }), 404, '其它 host 的 /admin');
    await expect(await adminPost('/invite', {}, { host: 'https://abot.run', headers: { Origin: 'https://abot.run' } }), 401, 'abot.run/invite 不是管理接口');
    await expect(await adminGet({ path: '/admin' }), 401, 'admin.abot.run/admin 不是管理页');
  }
  console.log('   ✓ admin 入口与 CSRF 校验正确');

  console.log('11j. admin 页安全头、CSP nonce、属性转义、异常处理...');
  {
    const evilId = 'x"><img src=x onerror=alert(1)>';
    D1.raw.prepare("INSERT INTO provision_requests (id, agent_name, status, created_at) VALUES (?, '<b>n</b>', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(evilId);
    const page = await adminGet();
    const html = await page.text();
    const h = (k) => page.headers.get(k) || '';
    const csp = h('content-security-policy');
    const nonce = (csp.match(/script-src 'nonce-([^']+)'/) || [])[1];
    if (!nonce) fail('CSP 应用 nonce 放行脚本: ' + csp);
    if (/script-src[^;]*unsafe-inline/.test(csp)) fail('script-src 不应有 unsafe-inline');
    for (const d of ["default-src 'none'", "style-src 'unsafe-inline'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'"]) {
      if (!csp.includes(d)) fail('CSP 缺少 ' + d);
    }
    if (!html.includes('<script nonce="' + nonce + '">')) fail('脚本标签应带同一个 nonce');
    if ((html.match(/<script/g) || []).length !== 1) fail('页面只应有一个脚本');
    const markup = html.replace(/<script[\s\S]*?<\/script>/, '').split('x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;').join('');
    if (/\son[a-z]+=/i.test(markup)) fail('页面不应有内联事件处理器');
    if (h('x-frame-options') !== 'DENY' || h('cache-control') !== 'no-store' || h('referrer-policy') !== 'no-referrer') fail('缺少安全头');
    const page2 = await adminGet();
    if ((page2.headers.get('content-security-policy') || '').includes(nonce)) fail('每次响应应生成新 nonce');
    if (html.includes(evilId) || html.includes('<img')) fail('data-id / 文本未转义');
    if (!html.includes('data-id="x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"')) fail('data-id 应 HTML 转义');
    D1.raw.prepare('DELETE FROM provision_requests WHERE id=?').run(evilId);

    const broken = { DB: { prepare() { const st = { bind() { return st; }, async first() { throw new Error('D1_ERROR secret detail'); }, async all() { throw new Error('D1_ERROR secret detail'); }, async run() { throw new Error('D1_ERROR secret detail'); } }; return st; }, async batch() { throw new Error('D1_ERROR secret detail'); } } };
    const g = await built.fetch(new Request(ADMIN + '/', { headers: { 'Cf-Access-Jwt-Assertion': J } }), broken);
    const gt = await g.text();
    if (g.status !== 500 || gt.includes('secret detail') || !gt.includes('internal_error')) fail('admin GET 出错应返回通用 500: ' + g.status + ' ' + gt);
    const pp = await built.fetch(new Request(ADMIN + '/approve', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': J, 'Content-Type': 'application/json', Origin: ADMIN }, body: '{"id":"x","email":"a@abot.run"}' }), broken);
    const ppt = await pp.text();
    if (pp.status !== 500 || ppt.includes('secret detail')) fail('admin POST 出错应返回通用 500: ' + pp.status + ' ' + ppt);
  }
  console.log('   ✓ admin 页安全头与异常处理正确');

  console.log('11k. Access JWT：exp/nbf/iss/alg 与未知 kid 刷新...');
  {
    const now = Math.floor(Date.now() / 1000);
    const status = async (jwt) => (await adminGet({ jwt })).status;
    const cases = [
      ['缺 exp', ak.claims({ exp: undefined }), 403],
      ['exp 为字符串', ak.claims({ exp: String(now + 3600) }), 403],
      ['过期 2 分钟', ak.claims({ exp: now - 120 }), 403],
      ['过期 30 秒（容差内）', ak.claims({ exp: now - 30 }), 200],
      ['nbf 在 5 分钟后', ak.claims({ nbf: now + 300 }), 403],
      ['nbf 在 30 秒后（容差内）', ak.claims({ nbf: now + 30 }), 200],
      ['nbf 已过', ak.claims({ nbf: now - 10 }), 200],
      ['iss 错误', ak.claims({ iss: 'https://evil.cloudflareaccess.com' }), 403],
      ['缺 iss', ak.claims({ iss: undefined }), 403],
      ['aud 为字符串', ak.claims({ aud: AUD_TAG }), 200],
    ];
    for (const [label, claims, want] of cases) {
      const got = await status(await ak.sign(JSON.parse(JSON.stringify(claims))));
      if (got !== want) fail('JWT ' + label + ': 期望 ' + want + '，实际 ' + got);
    }
    if (await status(await ak.sign(ak.claims(), { alg: 'HS256' })) !== 403) fail('header.alg 非 RS256 应拒绝');
    if (await status(await ak.sign(ak.claims(), { alg: 'none' })) !== 403) fail('header.alg=none 应拒绝');
    const tampered = J.split('.');
    tampered[1] = Buffer.from(JSON.stringify(ak.claims({ email: 'attacker@example.com' }))).toString('base64url');
    if (await status(tampered.join('.')) !== 403) fail('篡改 payload 应拒绝');
    const missingExpPost = await adminPost('/invite', {}, { jwt: await ak.sign(JSON.parse(JSON.stringify(ak.claims({ exp: undefined })))) });
    if (missingExpPost.status !== 403) fail('缺 exp 的 JWT 不能调用 admin POST');

    // 密钥轮换：缓存里只有 k1，新 JWT 用 k2 → 绕过缓存重新拉一次 JWKS 后通过
    ak.state.published = ['k1', 'k2'];
    const before = ak.state.certFetches;
    if (await status(await ak.sign(ak.claims(), { kid: 'k2' })) !== 200) fail('未知 kid 应刷新 JWKS 后通过');
    if (ak.state.certFetches !== before + 1) fail('未知 kid 应只强制刷新一次 JWKS，实际 ' + (ak.state.certFetches - before));
    if (await status(await ak.sign(ak.claims(), { kid: 'k2' })) !== 200) fail('刷新后的 kid 应命中缓存');
    if (ak.state.certFetches !== before + 1) fail('命中缓存不应再拉 JWKS');
    // 仍未知的 kid：30 秒内不再强制刷新，直接拒绝
    if (await status(await ak.sign(ak.claims(), { kid: 'k3' })) !== 403) fail('JWKS 里没有的 kid 应拒绝');
    if (ak.state.certFetches !== before + 1) fail('强制刷新应有间隔，防止伪造 kid 刷 JWKS');
  }
  console.log('   ✓ Access JWT 校验正确');
} finally {
  globalThis.fetch = savedFetch;
}

console.log('检查 install-skills.sh 的仓库地址...');
execSync('bash test/install-skills-urls.sh', { stdio: 'inherit' });

console.log('\n所有测试通过 ✓');
