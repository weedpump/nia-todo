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
run "Frontend App Downloads Visibility" node scripts/test_frontend_app_downloads.mjs
run "Frontend Login/Auth Layout" node scripts/test_frontend_login_auth_layout.mjs
run "Frontend Clear Done Projects" node scripts/test_frontend_clear_done_projects.mjs
run "Frontend Design Layout Contracts" node scripts/test_frontend_design_layout.mjs
run "Frontend Minimal Todo Mode Static Contract" node scripts/test_frontend_minimal_todos.mjs
run "Frontend Overview Stat Clamp" node scripts/test_frontend_overview_stat_clamp.mjs
run "Frontend Touch Zoom Lock" node scripts/test_frontend_touch_zoom_lock.mjs
run "Frontend UI Dropdown Primitive" node scripts/test_frontend_ui_dropdowns.mjs
run "Frontend User Menu Alignment" node scripts/test_frontend_user_menu_alignment.mjs
run "Frontend User Menu Scroll Anchor" node scripts/test_frontend_user_menu_scroll_anchor.mjs
run "Frontend Todo Menu Flip" node scripts/test_frontend_todo_menu_flip.mjs
run "Frontend Todo Action Breakpoints" node scripts/test_frontend_todo_action_breakpoints.mjs
run "Frontend Todo Modal Mobile Layout" node scripts/test_frontend_todo_modal_mobile_layout.mjs

echo
echo "✅ Optional UI contract suite green"
