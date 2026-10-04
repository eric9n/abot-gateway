// 构建脚本：把 src/admin.js 嵌入到 src/worker.js，输出到 dist/worker.js
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const worker = readFileSync('src/worker.js', 'utf8');
const adminJs = readFileSync('src/admin.js', 'utf8');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// worker.js 里是 `const ADMIN_JS = /*__ADMIN_JS__*/"<未构建提示>";`，整段替换成 admin.js 的 JSON 字符串字面量。
// JSON.stringify 负责转义引号、反斜杠和换行，admin.js 里出现反引号或 ${ 也不会破坏 worker 源码。
const marker = /\/\*__ADMIN_JS__\*\/"(?:[^"\\\n]|\\.)*"/g;
const hits = worker.match(marker) || [];
if (hits.length !== 1) die('worker.js 应恰好有一处 /*__ADMIN_JS__*/"..." 占位，实际 ' + hits.length);

// 运行时原样放进 <script>，这两种序列会提前结束脚本或改变 HTML 解析
if (/<\/script/i.test(adminJs) || adminJs.includes('<!--')) die('admin.js 不能包含 </script 或 <!--');

const built = worker.replace(marker, () => JSON.stringify(adminJs));
if (built.includes('/*__ADMIN_JS__*/')) die('构建后仍有 /*__ADMIN_JS__*/ 占位');

mkdirSync('dist', { recursive: true });
writeFileSync('dist/worker.js', built);
console.log('构建完成: dist/worker.js');
