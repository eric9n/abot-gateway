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
  if (!dist.includes("postJSON('invite'") || !dist.includes('data-action="invite"')) {
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

console.log('检查 install-skills.sh 的仓库地址...');
execSync('bash test/install-skills-urls.sh', { stdio: 'inherit' });

console.log('\n所有测试通过 ✓');
