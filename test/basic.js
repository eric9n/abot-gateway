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

console.log('\n所有测试通过 ✓');
