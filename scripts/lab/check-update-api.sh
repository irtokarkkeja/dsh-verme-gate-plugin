#!/usr/bin/env bash
# Проверка уведомления об обновлении: /verme-gate/api/update в отдельном доме.
set -uo pipefail
HOME_DIR=/home/seva/.dsh-dist-test
PORT=3098
LOG=/tmp/dist-update.log
NODE=/snap/node/current/bin/node
BIN=/home/seva/dsh-prod021-pkg/node_modules/@deepseek-ai/dsh/lib/bin.js
rm -f "$LOG"
DSH_HOME="$HOME_DIR" setsid nohup "$NODE" "$BIN" --profile web --host 127.0.0.1 --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!
TOKEN=""
for i in $(seq 1 60); do TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" | head -1 | cut -d= -f2); [ -n "$TOKEN" ] && break; sleep 1; done
COOKIE=$(mktemp)
curl -s -m 30 --noproxy "*" -c "$COOKIE" -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN"
echo '=== GET /verme-gate/api/update ==='
curl -s -m 90 --noproxy "*" -b "$COOKIE" "http://127.0.0.1:$PORT/verme-gate/api/update" -o /tmp/update.json -w 'http=%{http_code}\n'
$NODE -e 'const j=require("/tmp/update.json");console.log(JSON.stringify({installed:j.installed,latest:j.latest,updateAvailable:j.updateAvailable,checkedAt:j.checkedAt,source:j.source,error:j.error,compat:j.compat},null,1))'
kill "$PID" 2>/dev/null; sleep 2; kill -9 "$PID" 2>/dev/null
rm -f "$COOKIE"
echo 'процесс погашен'
