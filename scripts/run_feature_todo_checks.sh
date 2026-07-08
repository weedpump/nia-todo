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

echo "✅ nia-todo focused Todo feature suite"
echo "Use this before merging larger Todo UX/interaction changes."

run "Backend Core Todo Coverage" python3 scripts/test_backend.py
run "Subtasks API" python3 scripts/test_subtasks.py
run "Todo Comments API" python3 scripts/test_todo_comments.py
run "Todo Attachments API" python3 scripts/test_todo_attachments.py
run "Frontend Smoke" node scripts/test_frontend_smoke.mjs
run "Frontend App Core" node scripts/test_frontend_app.mjs
run "Frontend Subtasks" node scripts/test_frontend_subtasks.mjs
run "Frontend Quick Add Inline" node scripts/test_frontend_quick_add_inline.mjs
run "Frontend Todo Interactive Click Isolation" node scripts/test_frontend_todo_interactive_clicks.mjs
run "Frontend Android Todo Gestures" node scripts/test_frontend_android_todo_gestures.mjs

echo
echo "✅ Focused Todo feature suite green"
