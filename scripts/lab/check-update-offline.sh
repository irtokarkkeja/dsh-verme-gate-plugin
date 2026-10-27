#!/usr/bin/env bash
# Что отдаёт /api/update, когда до GitHub не достучаться (проверка «не врёт про актуальность»).
set -uo pipefail
HOME_DIR=/home/seva/.dsh-dist-test; PORT=3098; LOG=/tmp/dist-offline.log
NODE=/snap/node/current/bin/node; BIN=/home/seva/dsh-prod021-pkg/node_modules/@deepseek-ai/dsh/lib/bin.js
rm -f "$LOG"
HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NODE_USE_ENV_PROXY=1 \
  DSH_HOME="$HOME_DIR" setsid nohup "$NODE" "$BIN" --profile web --host 127.0.0.1 --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!
TOKEN=""; for i in $(seq 1 60); do TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" | head -1 | cut -d= -f2); [ -n "$TOKEN" ] && break; sleep 1; done
[ -n "$TOKEN" ] || { echo 'FAIL: нет токена'; tail -5 "$LOG"; kill "$PID"; exit 1; }
COOKIE=$(mktemp); curl -s -m 20 -c "$COOKIE" "http://127.0.0.1:$PORT/?token=$TOKEN" -o /dev/null
curl -s -m 90 -b "$COOKIE" "http://127.0.0.1:$PORT/verme-gate/api/update?force=1" -o /tmp/update-offline.json -w 'http=%{http_code}\n'
$NODE -e 'const j=require("/tmp/update-offline.json");console.log(JSON.stringify({version:j.version,latest:j.latest,available:j.available,source:j.source,error:String(j.error||"").slice(0,160)},null,1))'
kill "$PID" 2>/dev/null; sleep 2; kill -9 "$PID" 2>/dev/null; rm -f "$COOKIE"
