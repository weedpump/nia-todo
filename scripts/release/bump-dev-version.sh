#!/bin/bash
# Bump the working (develop) version to a "-dev" pre-release marker across
# source files and commit it on the current branch.
#
# Safe to merge into main at any point: the tag-triggered release workflow
# (prepare-release-version.sh) always overwrites these exact same strings
# unconditionally when a release is tagged, regardless of what was there
# before (including a leftover "-dev" suffix). So there is no coupling
# between this script and the release pipeline - bump develop whenever you
# start working on a new version, independent of release cadence on main.
#
# Usage: scripts/release/bump-dev-version.sh VERSION   (e.g. 3.0.3)
# Sets the working version to VERSION-dev, e.g. 3.0.3-dev.

set -euo pipefail

usage() {
    cat <<USAGE
Usage: $0 VERSION
Sets the working version to VERSION-dev (e.g. "$0 3.0.3" -> 3.0.3-dev).
USAGE
}

[ "$#" -eq 1 ] || { usage; exit 1; }
VERSION="$1"

if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "❌ Ungueltige Version: '${VERSION}' (erwartet MAJOR.MINOR.PATCH ohne -dev)"
    exit 1
fi

DEV_VERSION="${VERSION}-dev"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

sed -i "s/const APP_VERSION = 'v[^']*';/const APP_VERSION = 'v${DEV_VERSION}';/" web/static/js/core/config.js
sed -i "s/const SW_VERSION = 'v[^']*';/const SW_VERSION = 'v${DEV_VERSION}';/" web/sw.js
sed -i "s/<span class=\"version-text\">v[^<]*<\/span>/<span class=\"version-text\">v${DEV_VERSION}<\/span>/" web/index.html
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${DEV_VERSION}\"/" src-tauri/tauri.conf.json
sed -i "0,/^version = \"[^\"]*\"/s//version = \"${DEV_VERSION}\"/" src-tauri/Cargo.toml
sed -i "/name = \"nia-todo-desktop\"/{n;s/version = \"[^\"]*\"/version = \"${DEV_VERSION}\"/;}" src-tauri/Cargo.lock

python3 scripts/check_release_versions.py "${DEV_VERSION}"

git add \
    web/index.html \
    web/static/js/core/config.js \
    web/sw.js \
    src-tauri/tauri.conf.json \
    src-tauri/Cargo.toml \
    src-tauri/Cargo.lock

if git diff --cached --quiet; then
    echo "ℹ️  Working tree already at v${DEV_VERSION}, nothing to commit"
else
    git commit -m "chore: bump dev version to v${DEV_VERSION}"
    echo "✅ Dev version v${DEV_VERSION} set and committed"
fi
