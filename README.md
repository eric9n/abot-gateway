# aBot Gateway

统一 MCP 网关，聚合 mail/data/health/rules/secrets 五个后端服务。

## 开发

```bash
npm test          # 跑测试
npm run build     # 构建 dist/worker.js
```

## 部署

push 到 main 自动部署（需配置 GitHub Secrets）：
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 结构

- `src/worker.js`：网关主逻辑（含 `/*__ADMIN_JS__*/` 占位符）
- `src/admin.js`：Admin 页面前端 JS（构建时嵌入）
- `test/basic.js`：基础测试
- `build.js`：构建脚本
