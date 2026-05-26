#!/bin/bash
# Start nia-todo server

cd "$(dirname "$0")"
HOST="${NIA_TODO_HOST:-0.0.0.0}"
PORT="${NIA_TODO_PORT:-8753}"
echo "🚀 Starting nia-todo on http://${HOST}:${PORT}"
cd api
exec python3 -m uvicorn main:app --host "${HOST}" --port "${PORT}" --no-proxy-headers
