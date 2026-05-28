#!/bin/bash
# Export a clean public nia-todo source snapshot without private git history.
# Uses tracked-file allowlists plus public packaging overlays. Does not copy
# databases, build outputs, caches, node_modules, or the private .git history.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release/export-public.sh VERSION [--output DIR] [--init-git] [--force]

Options:
  --output DIR   Export target directory (default: dist/public/nia-todo-VERSION)
  --init-git     Initialize a fresh git repo and commit/tag the snapshot
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

OUTPUT="${OUTPUT:-dist/public/nia-todo-${VERSION}}"
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
      api/migrate_manual.py|api/change_admin_password.py) continue ;;
      web/downloads/*) [ "${file}" = "web/downloads/.gitkeep" ] || continue ;;
      src-tauri/target/*|src-tauri/frontend-dist/*|src-tauri/gen/android/app/build/*) continue ;;
      scripts/test_*|scripts/frontend_test_lib.mjs|scripts/*_test_*.mjs) continue ;;
      docs/workflow.md) continue ;;
      docs/native-apps-clean-architecture.md) continue ;;
      docs/internal-public-release-packaging.md) continue ;;
      systemd/nia-todo-dev.service|setup-dev.sh|release.sh) continue ;;
    esac
    mkdir -p "${OUTPUT_ABS}/$(dirname "${file}")"
    cp -p "${file}" "${OUTPUT_ABS}/${file}"
  done
}

for prefix in api web docs src-tauri; do
  copy_tracked_prefix "${prefix}"
done

for file in CHANGELOG.md LICENSE NOTICE package.json package-lock.json start.sh .gitignore; do
  if [ -f "${file}" ]; then
    cp -p "${file}" "${OUTPUT_ABS}/${file}"
  fi
done

# Public overlays replace private/dev-local files.
cp -p packaging/README.md "${OUTPUT_ABS}/README.md"
sed -i 's#../../web/static/icons/icon-512.png#web/static/icons/icon-512.png#g' "${OUTPUT_ABS}/README.md"
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
cp -p packaging/scripts/nia-todo-server-update.sh "${OUTPUT_ABS}/scripts/nia-todo-server-update.sh"
mkdir -p "${OUTPUT_ABS}/packaging/systemd"
cp -p packaging/systemd/nia-todo.service "${OUTPUT_ABS}/packaging/systemd/nia-todo.service"
cp -p packaging/systemd/nia-todo-backup.service "${OUTPUT_ABS}/packaging/systemd/nia-todo-backup.service"
cp -p packaging/systemd/nia-todo-backup.timer "${OUTPUT_ABS}/packaging/systemd/nia-todo-backup.timer"
mkdir -p "${OUTPUT_ABS}/systemd"
cp -p packaging/systemd/nia-todo.service "${OUTPUT_ABS}/systemd/nia-todo.service"
cp -p packaging/systemd/nia-todo-backup.service "${OUTPUT_ABS}/systemd/nia-todo-backup.service"
cp -p packaging/systemd/nia-todo-backup.timer "${OUTPUT_ABS}/systemd/nia-todo-backup.timer"


# Normalize release/public branding in the exported tree. The private dev working
# copy may be branded as Dev; public snapshots must be production-branded.
if [ -f "${OUTPUT_ABS}/web/static/js/core/config.js" ]; then
  sed -i "s/export const DB_NAME = 'nia-todo-db';/export const DB_NAME = 'nia-todo-db';/" "${OUTPUT_ABS}/web/static/js/core/config.js"
fi
if [ -f "${OUTPUT_ABS}/web/manifest.json" ]; then
  sed -i 's/"name": "nia-todo"/"name": "nia-todo"/' "${OUTPUT_ABS}/web/manifest.json"
  sed -i 's/"short_name": "nia-todo"/"short_name": "nia-todo"/' "${OUTPUT_ABS}/web/manifest.json"
fi
if [ -f "${OUTPUT_ABS}/web/index.html" ]; then
  sed -i 's/<title>nia-todo<\/title>/<title>nia-todo<\/title>/' "${OUTPUT_ABS}/web/index.html"
  sed -i 's/>nia-todo<\/span>/>nia-todo<\/span>/' "${OUTPUT_ABS}/web/index.html"
fi
if [ -f "${OUTPUT_ABS}/api/services/push.py" ]; then
  sed -i 's#mailto:nia-todo@kneidl-home.de#mailto:nia-todo@example.invalid#' "${OUTPUT_ABS}/api/services/push.py"
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
  echo "Public export contains private/dev markers:" >&2
  echo "${PRIVATE_HITS}" >&2
  exit 1
fi

if [ "${INIT_GIT}" = "1" ]; then
  git -C "${OUTPUT_ABS}" init -q
  git -C "${OUTPUT_ABS}" add .
  git -C "${OUTPUT_ABS}" commit -q -m "Release source snapshot ${VERSION}"
  git -C "${OUTPUT_ABS}" tag -a "v${VERSION}" -m "Release v${VERSION}"
fi

echo "✅ Public export created: ${OUTPUT_ABS}"
