---
name: abot
description: 占位 skill。通过 aBot 统一 MCP 网关使用 mail、data、health、rules、secrets。references/ 在仓库里手写维护。
---

# abot

这是占位 skill，还不是可执行的工具文档。

aBot Gateway 把 mail、data、health、rules、secrets 五个后端合成一个 MCP 入口（`POST /mcp`）。工具名形如 `<服务>_<工具>`。安装后本目录位于 `~/.muse/skills/abot/`。

- `bin/abot-mcp`：占位可执行文件。运行它只会说明自己还没实现。
- `references/`：mail、health、data、rules、secrets 各一份，在仓库里手写维护。

安装（需要 git；Origin 没有免认证 raw 文件，不能 curl 下载脚本）：

```bash
git clone --depth 1 https://origin.cursor.com/git/dagow/abot-gateway.git
bash abot-gateway/install-skills.sh
```
