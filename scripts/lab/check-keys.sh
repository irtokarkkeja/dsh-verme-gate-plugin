#!/usr/bin/env bash
# Показать ключи /api/state и /api/diag (что где искать при приёмке и разборе).
set -uo pipefail
HOME_DIR=/home/seva/.dsh-dist-test; PORT=3098; LOG=/tmp/dist-keys.log
NODE=/snap/node/current/bin/node; BIN=/home/seva/dsh-prod021-pkg/node_modules/@deepseek-ai/dsh/lib/bin.js
rm -f "$LOG"
DSH_HOME="$HOME_DIR" setsid nohup "$NODE" "$BIN" --profile web --host 127.0.0.1 --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!
TOKEN=""; for i in $(seq 1 60); do TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" | head -1 | cut -d= -f2); [ -n "$TOKEN" ] && break; sleep 1; done
COOKIE=$(mktemp); curl -s -m 20 -c "$COOKIE" "http://127.0.0.1:$PORT/?token=$TOKEN" -o /dev/null
for ROUTE in state diag; do
  curl -s -m 60 -b "$COOKIE" "http://127.0.0.1:$PORT/verme-gate/api/$ROUTE" -o /tmp/keys-$ROUTE.json
  echo "=== /api/$ROUTE top-level keys (+ phase) ==="
  $NODE -e 'const j=require("/tmp/keys-'"$ROUTE"'.json");console.log(Object.keys(j).join(", "));console.log("phase:", j.phase===undefined?"(нет в этом ответе)":j.phase)'
done
kill "$PID" 2>/dev/null; sleep 2; kill -9 "$PID" 2>/dev/null; rm -f "$COOKIE"
