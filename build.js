// 构建脚本：把 src/admin.js 嵌入到 src/worker.js，输出到 dist/worker.js
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const worker = readFileSync('src/worker.js', 'utf8');
const adminJs = readFileSync('src/admin.js', 'utf8');

// 替换 worker.js 中的 <script>...</script> 占位
// worker.js 里应该有一个标记：/*__ADMIN_JS__*/
if (!worker.includes('/*__ADMIN_JS__*/')) {
  console.error('worker.js 缺少 /*__ADMIN_JS__*/ 标记');
  process.exit(1);
}

const built = worker.replace('/*__ADMIN_JS__*/', () => adminJs);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/worker.js', built);
console.log('构建完成: dist/worker.js');
