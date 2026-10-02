#!/bin/bash
# Install a built server .deb as the real "nia-todo" systemd service and run
# the test suite against it - the same package a self-hoster would install,
# not a synthetic CI-only environment. Test scripts are excluded from the
# .deb itself (see stage-package-source.sh), so they run from this checkout
# but point at the installed app/data via env vars.
#
# Usage: scripts/release/install-and-test.sh DEB_FILE

set -euo pipefail

DEB_FILE="${1:-}"
[ -n "${DEB_FILE}" ] || { echo "Usage: $0 DEB_FILE" >&2; exit 2; }
[ -f "${DEB_FILE}" ] || { echo "No such file: ${DEB_FILE}" >&2; exit 2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

APP_DIR="/opt/nia-todo"
DATA_DIR="/var/lib/nia-todo"
SERVICE="nia-todo"
PORT="8753"

echo "📦 Installing ${DEB_FILE}..."
# Package integration tests start the real systemd service and restart it
# repeatedly. Route every update-related endpoint to loopback before postinst
# starts the service so CI cannot contact production update or analytics hosts.
sudo install -d -m 0755 /etc/systemd/system/nia-todo.service.d
printf '%s\n' \
  '[Service]' \
  'Environment=NIA_TODO_UPDATE_PRIMARY_URL=http://127.0.0.1:9/update/stable.json' \
  'Environment=NIA_TODO_UPDATE_RELEASE_API_URL=http://127.0.0.1:9/releases/latest' \
  'Environment=NIA_TODO_UPDATE_UMAMI_URL=http://127.0.0.1:9' \
  'Environment=NIA_TODO_UPDATE_UMAMI_WEBSITE_ID=' \
  | sudo tee /etc/systemd/system/nia-todo.service.d/90-ci-isolate-update-network.conf >/dev/null
sudo systemctl daemon-reload
sudo apt-get install -y "$(realpath "${DEB_FILE}")"

export NIA_TODO_DEV_DIR="${APP_DIR}"
export NIA_TODO_DATA_DIR="${DATA_DIR}"
export NIA_TODO_DB_NAME="nia-todo.db"
export NIA_TODO_SERVICE="${SERVICE}"
export NIA_TODO_URL="http://localhost:${PORT}"
export NIA_TODO_TEST_SUDO_FS=1
export NIA_TODO_TEST_SERVICE_USER="${SERVICE}"
export NIA_TODO_ALLOW_EMPTY_DEV_DB_BACKUP=1

echo "⏳ Waiting for ${SERVICE} on port ${PORT}..."
for _ in $(seq 1 60); do
  if curl -sf "${NIA_TODO_URL}/api/setup/status" >/dev/null 2>&1; then
    echo "✅ Service is up."
    break
  fi
  sleep 1
done
curl -sf "${NIA_TODO_URL}/api/setup/status" >/dev/null || { echo "❌ Service never became ready" >&2; sudo journalctl -u "${SERVICE}" --no-pager -n 100 >&2; exit 1; }

echo "🧪 Running test suite against the installed package..."
./scripts/test_all.sh
