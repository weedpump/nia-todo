#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "$1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

run_step() {
  local label="$1"
  shift
  step "$label"
  if "$@"; then
    echo "✅ OK: $label"
  else
    local code=$?
    echo "❌ FEHLER: $label"
    echo "   Exit-Code: $code"
    echo "   Abbruch — bitte Fehler oben prüfen."
    exit "$code"
  fi
}

step "🧪 nia-todo Test Suite"
echo "Repo: $(pwd)"
echo "Zeit: $(date '+%Y-%m-%d %H:%M:%S %Z')"

run_step "1/14 Backend-Tests" python3 scripts/test_backend.py
run_step "2/14 Service-Worker-Precache-Test" node scripts/test_sw_precache.mjs
run_step "3/14 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step "4/14 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step "5/14 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step "6/14 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step "7/14 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step "8/14 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step "9/14 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step "10/14 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step "11/14 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step "12/14 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step "13/14 Frontend-Offline-Sync-Test" node scripts/test_frontend_offline_sync.mjs
run_step "14/14 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
