#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

run() {
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "$1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  shift
  "$@"
}

echo "🎛️ nia-todo optional UI contract suite"
echo "Use this after broad visual/layout refactors, not as the default release gate."

run "Frontend API Error Adapter" node scripts/test_frontend_api_errors.mjs
run "Frontend Clear Done Projects" node scripts/test_frontend_clear_done_projects.mjs
run "Frontend Design Layout Contracts" node scripts/test_frontend_design_layout.mjs
run "Frontend Touch Zoom Lock" node scripts/test_frontend_touch_zoom_lock.mjs
run "Frontend UI Dropdown Primitive" node scripts/test_frontend_ui_dropdowns.mjs
run "Frontend Todo Modal Mobile Layout" node scripts/test_frontend_todo_modal_mobile_layout.mjs

echo
echo "✅ Optional UI contract suite green"
