#!/bin/bash
# Bump the shared release version across source files and commit it on the
# current branch (used by the tag-triggered GitHub Actions release workflow,
# which checks out `main` at the pushed tag's commit before calling this).
# Usage: scripts/release/prepare-release-version.sh VERSION [--set-min-app-version]

set -euo pipefail

usage() {
    cat <<USAGE
Usage: $0 VERSION [--set-min-app-version]
USAGE
}

VERSION=""
SET_MIN_APP_VERSION=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --set-min-app-version) SET_MIN_APP_VERSION=1; shift ;;
        --*) echo "❌ Unknown option: $1"; usage; exit 1 ;;
        *) [ -z "${VERSION}" ] || { echo "❌ Multiple versions supplied"; exit 1; }; VERSION="$1"; shift ;;
    esac
done
[ -n "${VERSION}" ] || { usage; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

validate_version() {
    local label="$1" value="$2"
    if ! [[ "${value}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "❌ Ungueltige ${label}-Version: '${value}'"
        exit 1
    fi
}

set_web_version() {
    local version_text="$1"
    sed -i "s/const APP_VERSION = 'v[^']*';/const APP_VERSION = 'v${version_text}';/" web/static/js/core/config.js
    sed -i "s/const SW_VERSION = 'v[^']*';/const SW_VERSION = 'v${version_text}';/" web/sw.js
    sed -i "s/<span class=\"version-text\">v[^<]*<\/span>/<span class=\"version-text\">v${version_text}<\/span>/" web/index.html
}

set_tauri_version() {
    local app_version="$1"
    sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${app_version}\"/" src-tauri/tauri.conf.json
    sed -i "0,/^version = \"[^\"]*\"/s//version = \"${app_version}\"/" src-tauri/Cargo.toml
    sed -i "/name = \"nia-todo-desktop\"/{n;s/version = \"[^\"]*\"/version = \"${app_version}\"/;}" src-tauri/Cargo.lock
}

set_prod_branding() {
    sed -i "s/const DB_NAME = 'nia-todo-db';/const DB_NAME = 'nia-todo-db';/" web/static/js/core/config.js
    sed -i 's/"name": "nia-todo",/"name": "nia-todo",/' web/manifest.json
    sed -i 's/"short_name": "nia-todo",/"short_name": "nia-todo",/' web/manifest.json
    sed -i 's/<title>nia-todo<\/title>/<title>nia-todo<\/title>/' web/index.html
    sed -i 's/>nia-todo<\/span>/>nia-todo<\/span>/' web/index.html
}

set_min_native_client_version_source() {
    local version_text="$1"
    python3 - "$version_text" <<'PY'
from pathlib import Path
import re
import sys

version = sys.argv[1]
source_path = Path("api/services/instance_config.py")
source_text = source_path.read_text(encoding="utf-8")
source_text, count = re.subn(
    r'SOURCE_MIN_NATIVE_CLIENT_VERSION = "[0-9A-Za-z.-]+"',
    f'SOURCE_MIN_NATIVE_CLIENT_VERSION = "{version}"',
    source_text,
    count=1,
)
if count != 1:
    raise SystemExit("Could not update min_native_client_version source floor")
source_path.write_text(source_text, encoding="utf-8")

migration_path = Path("api/migrations/029_add_min_native_client_version_config.sql")
migration_text = migration_path.read_text(encoding="utf-8")
migration_text, count = re.subn(
    r"\('min_native_client_version', '[0-9A-Za-z.-]+'\)",
    f"('min_native_client_version', '{version}')",
    migration_text,
    count=1,
)
if count != 1:
    raise SystemExit("Could not update min_native_client_version migration default")
migration_path.write_text(migration_text, encoding="utf-8")
PY
}

require_source_version() {
    local version_text="$1"
    local tag="v${version_text}"
    grep -Fq "export const APP_VERSION = '${tag}';" web/static/js/core/config.js || { echo "❌ APP_VERSION ist nicht ${tag}"; exit 1; }
    grep -Fq "const SW_VERSION = '${tag}';" web/sw.js || { echo "❌ SW_VERSION ist nicht ${tag}"; exit 1; }
    grep -Fq "<span class=\"version-text\">${tag}</span>" web/index.html || { echo "❌ sichtbare Web-Version ist nicht ${tag}"; exit 1; }
    grep -Fq "\"version\": \"${version_text}\"" src-tauri/tauri.conf.json || { echo "❌ Tauri-Version ist nicht ${version_text}"; exit 1; }
    grep -Eq "^version = \"${version_text}\"$" src-tauri/Cargo.toml || { echo "❌ Cargo.toml-Version ist nicht ${version_text}"; exit 1; }
}

require_changelog_section() {
    local file="$1" version="$2"
    [ -f "${file}" ] || { echo "❌ Changelog fehlt: ${file}"; exit 1; }
    grep -Eq "^## \\[${version}\\]([[:space:]]|-|$)" "${file}" || {
        echo "❌ ${file} enthält keinen Abschnitt fuer Version ${version}"
        exit 1
    }
}

validate_version "Release" "${VERSION}"
require_changelog_section "CHANGELOG.md" "${VERSION}"

set_prod_branding
set_web_version "${VERSION}"
set_tauri_version "${VERSION}"
if [ "${SET_MIN_APP_VERSION}" = "1" ]; then
    echo "📱 Setting minimum native app version to ${VERSION}"
    set_min_native_client_version_source "${VERSION}"
fi
require_source_version "${VERSION}"
python3 scripts/check_release_versions.py "${VERSION}"

git add \
    web/manifest.json \
    web/index.html \
    web/sw.js \
    web/static/js/core/config.js \
    src-tauri/tauri.conf.json \
    src-tauri/Cargo.toml \
    src-tauri/Cargo.lock \
    api/services/instance_config.py \
    api/migrations/029_add_min_native_client_version_config.sql
git commit -m "chore: prepare release v${VERSION}"
echo "✅ Release version v${VERSION} prepared and committed"
