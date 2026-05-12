#!/bin/bash
# Start nia-todo server

cd "$(dirname "$0")"
echo "🚀 Starting nia-todo on http://0.0.0.0:8753"
cd api
exec python3 -m uvicorn main:app --host 0.0.0.0 --port 8753
