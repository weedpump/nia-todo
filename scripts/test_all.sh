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

run_step "1/9 Backend-Tests" python3 scripts/test_backend.py
run_step "2/9 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step "3/9 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step "4/9 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step "5/9 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step "6/9 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step "7/9 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step "8/9 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs
run_step "9/9 Frontend-Sharing-Test" node scripts/test_frontend_sharing.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
