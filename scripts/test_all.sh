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

run_step "1/12 Backend-Tests" python3 scripts/test_backend.py
run_step "2/12 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step "3/12 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step "4/12 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step "5/12 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step "6/12 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step "7/12 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step "8/12 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step "9/12 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs
run_step "10/12 Frontend-Security-Test" node scripts/test_frontend_security.mjs
run_step "11/12 Frontend-Session-Test" node scripts/test_frontend_session.mjs
run_step "12/12 Frontend-Native-Offline-Test" node scripts/test_frontend_native_offline.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
