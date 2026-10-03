#!/usr/bin/env bash
# 检查 install-skills.sh 拼出来的仓库地址。不访问网络：git 用桩替换。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

fail() { printf 'install-skills-urls: %s\n' "$*" >&2; exit 1; }

EXPECTED_REPO="https://origin.cursor.com/git/dagow/abot-gateway.git"

bash -n install-skills.sh

repo="$(bash -c 'source ./install-skills.sh; default_repo_url')"
[[ "${repo}" == "${EXPECTED_REPO}" ]] || fail "default_repo_url=${repo}"

ref="$(bash -c 'source ./install-skills.sh; default_ref')"
[[ "${ref}" == "main" ]] || fail "default_ref=${ref}"

repo="$(env -u ABOT_SKILLS_REPO bash -c 'source ./install-skills.sh; printf %s "$REPO"')"
[[ "${repo}" == "${EXPECTED_REPO}" ]] || fail "REPO=${repo}"

ref="$(env -u ABOT_SKILLS_REF bash -c 'source ./install-skills.sh; printf %s "$REF"')"
[[ "${ref}" == "main" ]] || fail "REF=${ref}"

repo="$(ABOT_SKILLS_REPO='https://example.test/mirror.git' bash -c 'source ./install-skills.sh; printf %s "$REPO"')"
[[ "${repo}" == "https://example.test/mirror.git" ]] || fail "override REPO=${repo}"

ref="$(ABOT_SKILLS_REF='dev' bash -c 'source ./install-skills.sh; printf %s "$REF"')"
[[ "${ref}" == "dev" ]] || fail "override REF=${ref}"

for f in install-skills.sh README.md skills/abot/SKILL.md; do
  if grep -E 'raw\.githubusercontent\.com|github\.com/dagow|ABOT_SKILLS_RAW' "${f}" >/dev/null; then
    fail "${f} still points at GitHub or the raw fallback"
  fi
done

TMP="$(mktemp -d)"
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

mkdir -p "${TMP}/bin" "${TMP}/curlonly"
cat > "${TMP}/bin/git" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "${GIT_LOG:?}"
printf '\n' >> "${GIT_LOG}"
if [[ "$1" == "clone" ]]; then
  printf '%s\n' "${@: -2:1}" > "${GIT_CLONE_URL:?}"
  prev=""
  for arg in "$@"; do
    if [[ "${prev}" == "--branch" ]]; then
      printf '%s\n' "${arg}" > "${GIT_CLONE_REF:?}"
    fi
    prev="${arg}"
  done
  dest="${@: -1}"
  mkdir -p "${dest}/skills/abot/bin"
  printf 'skill\n' > "${dest}/skills/abot/SKILL.md"
  printf '#!/bin/sh\necho stub\n' > "${dest}/skills/abot/bin/abot-mcp"
fi
exit 0
EOF
cat > "${TMP}/curlonly/curl" << 'EOF'
#!/bin/sh
printf 'called\n' > "${CURL_CALLED:?}"
exit 99
EOF
chmod +x "${TMP}/bin/git" "${TMP}/curlonly/curl"

run_install() {
  local dest="$1"
  shift
  env -u ABOT_SKILLS_REPO -u ABOT_SKILLS_REF \
    PATH="${TMP}/bin:/usr/bin:/bin" \
    HOME="${TMP}/home" \
    GIT_LOG="${TMP}/git.log" \
    GIT_CLONE_URL="${TMP}/clone.url" \
    GIT_CLONE_REF="${TMP}/clone.ref" \
    ABOT_SKILLS_DEST="${dest}" \
    "$@" \
    bash ./install-skills.sh
}

: > "${TMP}/git.log"
rm -f "${TMP}/clone.url" "${TMP}/clone.ref"
mkdir -p "${TMP}/home"
run_install "${TMP}/home/.muse/skills/abot"

[[ "$(cat "${TMP}/clone.url")" == "${EXPECTED_REPO}" ]] || fail "clone url=$(cat "${TMP}/clone.url")"
[[ "$(cat "${TMP}/clone.ref")" == "main" ]] || fail "clone ref=$(cat "${TMP}/clone.ref")"
grep -F -- '--branch main' "${TMP}/git.log" >/dev/null || fail "clone log missing --branch main"
grep -F -- 'sparse-checkout set --no-cone skills/abot' "${TMP}/git.log" >/dev/null || fail "missing sparse-checkout"
[[ -f "${TMP}/home/.muse/skills/abot/SKILL.md" ]] || fail "SKILL.md missing"
[[ -x "${TMP}/home/.muse/skills/abot/bin/abot-mcp" ]] || fail "abot-mcp not executable"

: > "${TMP}/git.log"
rm -f "${TMP}/clone.url" "${TMP}/clone.ref"
run_install "${TMP}/home/.muse/skills/abot" \
  ABOT_SKILLS_REPO='https://example.test/mirror.git' \
  ABOT_SKILLS_REF='dev'
[[ "$(cat "${TMP}/clone.url")" == "https://example.test/mirror.git" ]] || fail "override clone url=$(cat "${TMP}/clone.url")"
[[ "$(cat "${TMP}/clone.ref")" == "dev" ]] || fail "override clone ref=$(cat "${TMP}/clone.ref")"

BASH_BIN="$(command -v bash)"
rm -f "${TMP}/curl.called"
set +e
msg="$(
  env -u ABOT_SKILLS_REPO \
    PATH="${TMP}/curlonly" \
    HOME="${TMP}/home" \
    CURL_CALLED="${TMP}/curl.called" \
    ABOT_SKILLS_DEST="${TMP}/home/.muse/skills/abot" \
    "${BASH_BIN}" ./install-skills.sh 2>&1
)"
code=$?
set -e
[[ "${code}" -ne 0 ]] || fail "missing git should fail"
[[ "${msg}" == *"需要 git"* ]] || fail "missing git message: ${msg}"
[[ "${msg}" == *"${EXPECTED_REPO}"* ]] || fail "missing git message should name the repo: ${msg}"
[[ "${msg}" != *"raw.githubusercontent.com"* && "${msg}" != *"github.com"* ]] || fail "missing git message mentions GitHub: ${msg}"
[[ ! -e "${TMP}/curl.called" ]] || fail "curl ran without git"

rm -f "${TMP}/curl.called"
set +e
msg="$(
  PATH="${TMP}/curlonly" \
    HOME="${TMP}/home" \
    CURL_CALLED="${TMP}/curl.called" \
    ABOT_SKILLS_DEST="${TMP}/home/.muse/skills/abot" \
    ABOT_SKILLS_REPO='https://example.test/mirror.git' \
    "${BASH_BIN}" ./install-skills.sh 2>&1
)"
code=$?
set -e
[[ "${code}" -ne 0 ]] || fail "missing git with override should fail"
[[ "${msg}" == *"https://example.test/mirror.git"* ]] || fail "override missing-git message: ${msg}"
[[ ! -e "${TMP}/curl.called" ]] || fail "curl ran for override repo"

printf 'install-skills URL checks passed\n'
