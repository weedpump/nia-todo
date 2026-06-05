#!/bin/bash
# Start nia-todo server

cd "$(dirname "$0")"
HOST="${NIA_TODO_HOST:-auto}"
PORT="${NIA_TODO_PORT:-8753}"
echo "🚀 Starting nia-todo on http://${HOST}:${PORT}"
cd api
exec env NIA_TODO_HOST="${HOST}" NIA_TODO_PORT="${PORT}" python3 run_server.py
