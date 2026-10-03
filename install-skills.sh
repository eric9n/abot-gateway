#!/usr/bin/env bash
# 把 abot skills 装到 ~/.muse/skills/abot/。
#
# 仓库在 Cursor Origin，不在 GitHub：
#   https://origin.cursor.com/git/dagow/abot-gateway.git
#
# Origin 的 Get Blob 需要 repository:contents:read，没有免认证 raw 文件。
# GitHub 上没有这个仓库，也不能 curl | bash。
#
# 用法（需要 git，并且当前环境能克隆该仓库，例如已经 origin auth login）：
#   git clone --depth 1 https://origin.cursor.com/git/dagow/abot-gateway.git
#   bash abot-gateway/install-skills.sh
#
# 已经有这份脚本时：
#   ./install-skills.sh
#
# 脚本再用 sparse-checkout 只拉 skills/abot，新文件不用另维护清单。
# 没有 git 时直接退出并说明需要 git。
# 可选环境变量：ABOT_SKILLS_REPO、ABOT_SKILLS_REF、ABOT_SKILLS_DEST。
set -euo pipefail

# 默认克隆地址。测试会 source 本文件并调用这两个函数，确认没有拼出 GitHub URL。
default_repo_url() {
  printf '%s\n' "https://origin.cursor.com/git/dagow/abot-gateway.git"
}

default_ref() {
  printf '%s\n' "main"
}

REPO="${ABOT_SKILLS_REPO:-$(default_repo_url)}"
REF="${ABOT_SKILLS_REF:-$(default_ref)}"
DEST="${ABOT_SKILLS_DEST:-${HOME}/.muse/skills/abot}"

log() { printf '%s\n' "$*"; }
die() { printf 'install-skills: %s\n' "$*" >&2; exit 1; }

CLONE_TMP=""
STAGE=""
cleanup() {
  if [[ -n "${CLONE_TMP}" ]]; then
    rm -rf "${CLONE_TMP}"
  fi
  if [[ -n "${STAGE}" && -d "${STAGE}" ]]; then
    rm -rf "${STAGE}"
  fi
}

# 把已检出的 skills/abot 换成安装目录。重跑会换掉旧文件，不动旁边的其他 skill。
install_tree() {
  local src="$1"
  local parent
  [[ -f "${src}/SKILL.md" ]] || die "missing SKILL.md in ${src}"
  [[ -f "${src}/bin/abot-mcp" ]] || die "missing bin/abot-mcp in ${src}"
  parent="$(dirname "${DEST}")"
  mkdir -p "${parent}"
  STAGE="$(mktemp -d "${parent}/.abot-install.XXXXXX")"
  cp -a "${src}/." "${STAGE}/"
  chmod +x "${STAGE}/bin/abot-mcp"
  rm -rf "${DEST}"
  mv "${STAGE}" "${DEST}"
  STAGE=""
  [[ -x "${DEST}/bin/abot-mcp" ]] || die "failed to mark bin/abot-mcp executable"
}

install_with_git() {
  CLONE_TMP="$(mktemp -d)"
  log "使用 git sparse-checkout 安装 ${REPO} (${REF}) → ${DEST}"
  # --no-checkout 避免先拉仓库根文件；--no-cone 只匹配 skills/abot。
  # stdin 重定向到 /dev/null，避免脚本从管道运行时 git 把剩余输入读走。
  git clone --depth 1 --filter=blob:none --sparse --no-checkout --branch "${REF}" "${REPO}" "${CLONE_TMP}/repo" </dev/null
  git -C "${CLONE_TMP}/repo" sparse-checkout set --no-cone 'skills/abot'
  git -C "${CLONE_TMP}/repo" checkout
  [[ -d "${CLONE_TMP}/repo/skills/abot" ]] || die "sparse-checkout did not produce skills/abot"
  install_tree "${CLONE_TMP}/repo/skills/abot"
}

main() {
  if [[ -z "${DEST}" || "${DEST}" == "/" || "${DEST}" == "${HOME}" || "${DEST}" == "${HOME}/.muse" || "${DEST}" == "${HOME}/.muse/skills" ]]; then
    die "refusing to install to '${DEST}'"
  fi

  trap cleanup EXIT

  if ! command -v git >/dev/null 2>&1; then
    die "需要 git。Cursor Origin 没有免认证 raw 文件，curl 无法下载 ${REPO}。请先安装 git，并确认能克隆该仓库（例如 origin auth login）。"
  fi

  install_with_git
  log "已安装 abot skills：${DEST}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
