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

run_step "1/8 Backend-Tests" python3 scripts/test_backend.py
run_step "2/8 Frontend-Smoke-Test" node scripts/test_frontend_smoke.mjs
run_step "3/8 Frontend-App-Test" node scripts/test_frontend_app.mjs
run_step "4/8 Frontend-Setup-Test" node scripts/test_frontend_setup.mjs
run_step "5/8 Frontend-Admin-Test" node scripts/test_frontend_admin.mjs
run_step "6/8 Frontend-Settings-Test" node scripts/test_frontend_settings.mjs
run_step "7/8 Frontend-Projects-Test" node scripts/test_frontend_projects.mjs
run_step "8/8 Frontend-DragDrop-Test" node scripts/test_frontend_dragdrop.mjs

echo
echo "🎉 Alles grün — alle Tests erfolgreich bestanden"
