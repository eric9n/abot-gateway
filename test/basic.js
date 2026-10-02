// 基础测试：验证 worker.js 语法和关键逻辑
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

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
const worker = readFileSync('src/worker.js', 'utf8');
if (!worker.includes('/*__ADMIN_JS__*/')) {
  console.error('   ✗ 缺少 /*__ADMIN_JS__*/ 占位符');
  process.exit(1);
}
console.log('   ✓ 占位符存在');

console.log('4. 检查关键路由...');
const routes = ['/mcp', '/oauth/authorize', '/oauth/token', '/oauth/register', '/admin'];
for (const r of routes) {
  if (!worker.includes(`"${r}"`) && !worker.includes(`'${r}'`)) {
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
  if (!worker.includes(s)) { console.error(`   ✗ 缺少 ${name}`); process.exit(1); }
}
console.log('   ✓ 安全项齐全');

console.log('6. 检查无危险模式...');
const bad = [
  ['Math.random().toString(36)', 'Math.random 生成凭证'],
  ['/debug/db', '调试端点'],
  ['String(e.message || e)', '错误泄漏'],
  ['GATEWAY_TOKEN', '已删除的静态 token'],
];
for (const [s, name] of bad) {
  if (worker.includes(s)) { console.error(`   ✗ 发现 ${name}: ${s}`); process.exit(1); }
}
console.log('   ✓ 无危险模式');

console.log('\n所有测试通过 ✓');
