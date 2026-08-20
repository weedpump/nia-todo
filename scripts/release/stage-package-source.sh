#!/bin/bash
# Stage the file tree that becomes the Docker image / server .deb payload:
# tracked source plus the packaging/ overlay (Dockerfile, docker-compose.yml,
# install.sh, backup scripts, production systemd units, self-hoster README),
# excluding dev/test-only files, build outputs, and the git history.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/stage-package-source.sh VERSION [--output DIR] [--init-git] [--force]

Options:
  --output DIR   Output target directory (default: dist/package/nia-todo-VERSION)
  --init-git     Initialize a fresh git repo and commit/tag the staged tree
  --force        Remove an existing output directory first
USAGE
}

VERSION=""
OUTPUT=""
INIT_GIT=0
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --output) OUTPUT="${2:-}"; [ -n "${OUTPUT}" ] || { echo "Missing --output value" >&2; exit 2; }; shift 2 ;;
    --init-git) INIT_GIT=1; shift ;;
    --force) FORCE=1; shift ;;
    --*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *) [ -z "${VERSION}" ] || { echo "Multiple versions supplied" >&2; exit 2; }; VERSION="$1"; shift ;;
  esac
done

[ -n "${VERSION}" ] || { usage; exit 2; }
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version: ${VERSION}" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

OUTPUT="${OUTPUT:-dist/package/nia-todo-${VERSION}}"
OUTPUT_ABS="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${OUTPUT}")"

if [ -e "${OUTPUT_ABS}" ]; then
  [ "${FORCE}" = "1" ] || { echo "Output exists: ${OUTPUT_ABS} (use --force)" >&2; exit 1; }
  rm -rf "${OUTPUT_ABS}"
fi
mkdir -p "${OUTPUT_ABS}"

copy_tracked_prefix() {
  local prefix="$1"
  git ls-files "${prefix}" | while IFS= read -r file; do
    case "${file}" in
      */__pycache__/*|*.pyc|*.pyo|*.db|*.db-*|*.db.backup*|*.db.bak) continue ;;
      api/data/*) [ "${file}" = "api/data/.gitkeep" ] || continue ;;
      api/migrate_manual.py) continue ;;
      web/downloads/*) [ "${file}" = "web/downloads/.gitkeep" ] || continue ;;
      src-tauri/target/*|src-tauri/frontend-dist/*|src-tauri/gen/android/app/build/*) continue ;;
      scripts/test_*|scripts/frontend_test_lib.mjs|scripts/*_test_*.mjs) continue ;;
      docs/native-apps-clean-architecture.md) continue ;;
    esac
    mkdir -p "${OUTPUT_ABS}/$(dirname "${file}")"
    cp -p "${file}" "${OUTPUT_ABS}/${file}"
  done
}

for prefix in api web src-tauri; do
  copy_tracked_prefix "${prefix}"
done

# Package documentation is allowlisted deliberately. Do not copy the whole
# docs/ tree wholesale; add docs here only when they are meant to ship inside
# the package.
mkdir -p "${OUTPUT_ABS}/docs"
cp -p docs/api.md "${OUTPUT_ABS}/docs/api.md"

for file in CHANGELOG.md LICENSE NOTICE package.json package-lock.json start.sh .gitignore; do
  if [ -f "${file}" ]; then
    cp -p "${file}" "${OUTPUT_ABS}/${file}"
  fi
done

# packaging/ overlay: self-hoster README, Dockerfile, docker-compose.yml,
# install/backup/restore scripts, and pinned requirements.
cp -p README.md "${OUTPUT_ABS}/README.md"
if [ -d packaging/docs ]; then
  mkdir -p "${OUTPUT_ABS}/docs"
  cp -a packaging/docs/. "${OUTPUT_ABS}/docs/"
fi
cp -p packaging/requirements.txt "${OUTPUT_ABS}/requirements.txt"
cp -p packaging/Dockerfile "${OUTPUT_ABS}/Dockerfile"
cp -p packaging/docker-compose.yml "${OUTPUT_ABS}/docker-compose.yml"
cp -p packaging/install.sh "${OUTPUT_ABS}/install.sh"
mkdir -p "${OUTPUT_ABS}/scripts"
cp -p packaging/scripts/backup.sh "${OUTPUT_ABS}/scripts/backup.sh"
cp -p packaging/scripts/nia-todo-backup.sh "${OUTPUT_ABS}/scripts/nia-todo-backup.sh"
cp -p packaging/scripts/nia-todo-restore.sh "${OUTPUT_ABS}/scripts/nia-todo-restore.sh"
cp -p packaging/scripts/nia-todo-admin-password-reset.sh "${OUTPUT_ABS}/scripts/nia-todo-admin-password-reset.sh"
cp -p packaging/scripts/nia-todo-server-update.sh "${OUTPUT_ABS}/scripts/nia-todo-server-update.sh"
mkdir -p "${OUTPUT_ABS}/packaging/systemd"
cp -p systemd/nia-todo.service "${OUTPUT_ABS}/packaging/systemd/nia-todo.service"
cp -p systemd/nia-todo-backup.service "${OUTPUT_ABS}/packaging/systemd/nia-todo-backup.service"
cp -p systemd/nia-todo-backup.timer "${OUTPUT_ABS}/packaging/systemd/nia-todo-backup.timer"

# Stamp the version into the staged web files (source stays at whatever
# version prepare-release-version.sh already set on the branch/tag).
if [ -f "${OUTPUT_ABS}/web/static/js/core/config.js" ]; then
  sed -i "s/export const APP_VERSION = 'v[^']*';/export const APP_VERSION = 'v${VERSION}';/" "${OUTPUT_ABS}/web/static/js/core/config.js"
fi
if [ -f "${OUTPUT_ABS}/web/index.html" ]; then
  sed -i "s/<span class=\"version-text\">v[^<]*<\/span>/<span class=\"version-text\">v${VERSION}<\/span>/" "${OUTPUT_ABS}/web/index.html"
fi
if [ -f "${OUTPUT_ABS}/web/sw.js" ]; then
  sed -i "s/const SW_VERSION = 'v[^']*';/const SW_VERSION = 'v${VERSION}';/" "${OUTPUT_ABS}/web/sw.js"
fi
mkdir -p "${OUTPUT_ABS}/web/downloads" "${OUTPUT_ABS}/api/data"
[ -f "${OUTPUT_ABS}/web/downloads/.gitkeep" ] || : > "${OUTPUT_ABS}/web/downloads/.gitkeep"
[ -f "${OUTPUT_ABS}/api/data/.gitkeep" ] || : > "${OUTPUT_ABS}/api/data/.gitkeep"

# Fail on local/private markers. Some package names contain tobiaskneidl by design;
# those are not treated as private secrets here.
PRIVATE_HITS="$(grep -RInE '/root/\.openclaw|10\.0\.10\.35|nia-todo-dev|kneidl-home|service-tokens|\.secrets' "${OUTPUT_ABS}" \
  --exclude-dir='.git' \
  --exclude='package-lock.json' || true)"
if [ -n "${PRIVATE_HITS}" ]; then
  echo "Staged package contains private/dev markers:" >&2
  echo "${PRIVATE_HITS}" >&2
  exit 1
fi

if [ "${INIT_GIT}" = "1" ]; then
  git -C "${OUTPUT_ABS}" init -q
  git -C "${OUTPUT_ABS}" add .
  git -C "${OUTPUT_ABS}" commit -q -m "Package source snapshot ${VERSION}"
  git -C "${OUTPUT_ABS}" tag -a "v${VERSION}" -m "Release v${VERSION}"
fi

echo "✅ Package source staged: ${OUTPUT_ABS}"
