#!/usr/bin/env bash
# 把 abot skills 装到 ~/.muse/skills/abot/。
#
#   curl -fsSL https://raw.githubusercontent.com/dagow/abot-gateway/main/install-skills.sh | bash
#
# 有 git 时用 sparse-checkout 只拉 skills/abot；没有 git 时用 curl 逐文件下载。
# 可选环境变量（测试或镜像）：ABOT_SKILLS_REPO、ABOT_SKILLS_REF、ABOT_SKILLS_RAW、ABOT_SKILLS_DEST。
set -euo pipefail

REPO="${ABOT_SKILLS_REPO:-https://github.com/dagow/abot-gateway.git}"
REF="${ABOT_SKILLS_REF:-main}"
RAW="${ABOT_SKILLS_RAW:-https://raw.githubusercontent.com/dagow/abot-gateway/${REF}}"
DEST="${ABOT_SKILLS_DEST:-${HOME}/.muse/skills/abot}"

# 相对 skills/abot/。dumper 若新增文件，这里要一起加上，curl 降级才会拉到。
FILES=(
  SKILL.md
  bin/abot-mcp
  references/mail.md
  references/health.md
  references/data.md
  references/rules.md
  references/secrets.md
)

log() { printf '%s\n' "$*"; }
die() { printf 'install-skills: %s\n' "$*" >&2; exit 1; }

if [[ -z "${DEST}" || "${DEST}" == "/" || "${DEST}" == "${HOME}" || "${DEST}" == "${HOME}/.muse" || "${DEST}" == "${HOME}/.muse/skills" ]]; then
  die "refusing to install to '${DEST}'"
fi

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
trap cleanup EXIT

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
  # stdin 重定向到 /dev/null，避免 curl | bash 时 git 把脚本剩下的内容读走。
  git clone --depth 1 --filter=blob:none --sparse --no-checkout --branch "${REF}" "${REPO}" "${CLONE_TMP}/repo" </dev/null
  git -C "${CLONE_TMP}/repo" sparse-checkout set --no-cone 'skills/abot'
  git -C "${CLONE_TMP}/repo" checkout
  [[ -d "${CLONE_TMP}/repo/skills/abot" ]] || die "sparse-checkout did not produce skills/abot"
  install_tree "${CLONE_TMP}/repo/skills/abot"
}

install_with_curl() {
  local tmp f dir
  tmp="$(mktemp -d)"
  CLONE_TMP="${tmp}"
  log "未找到 git，改用 curl 逐文件安装 → ${DEST}"
  mkdir -p "${tmp}/abot"
  for f in "${FILES[@]}"; do
    dir="$(dirname "${f}")"
    mkdir -p "${tmp}/abot/${dir}"
    curl -fsSL "${RAW}/skills/abot/${f}" -o "${tmp}/abot/${f}" </dev/null
  done
  install_tree "${tmp}/abot"
}

if command -v git >/dev/null 2>&1; then
  install_with_git
else
  command -v curl >/dev/null 2>&1 || die "需要 git 或 curl"
  install_with_curl
fi

log "已安装 abot skills：${DEST}"
