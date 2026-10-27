#!/usr/bin/env bash
# Дословный прогон блока приёмки из docs/DISTRIBUTE-verme-gate.md §6.3 (терминальная приёмка).
set -uo pipefail
DSH_HOME_DIR=/home/seva/.dsh-dist-test
PORT=3098
LOG=/tmp/dist-accept.log
NODE=/snap/node/current/bin/node
BIN=/home/seva/dsh-prod021-pkg/node_modules/@deepseek-ai/dsh/lib/bin.js

rm -f "$LOG"
DSH_HOME="$DSH_HOME_DIR" setsid nohup "$NODE" "$BIN" --profile web --host 127.0.0.1 --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!
TOKEN=""
for i in $(seq 1 60); do TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" | head -1 | cut -d= -f2); [ -n "$TOKEN" ] && break; sleep 1; done
[ -n "$TOKEN" ] || { echo 'FAIL: нет токена в логе'; tail -5 "$LOG"; kill "$PID"; exit 1; }

echo '--- §6.3 dословно ---'
COOKIE=$(mktemp)
curl -s -c $COOKIE "http://127.0.0.1:$PORT/?token=$TOKEN" -o /dev/null
curl -s -b $COOKIE "http://127.0.0.1:$PORT/verme-gate" -o /dev/null -w 'verme-gate: %{http_code}\n'
echo -n 'api/state: '; curl -s -b $COOKIE "http://127.0.0.1:$PORT/verme-gate/api/state" | head -c 220; echo
echo -n 'api/diag:  '; curl -s -b $COOKIE "http://127.0.0.1:$PORT/verme-gate/api/diag" | head -c 160; echo
echo -n 'api/update:'; curl -s -b $COOKIE "http://127.0.0.1:$PORT/verme-gate/api/update" | head -c 200; echo

kill "$PID" 2>/dev/null; sleep 2; kill -9 "$PID" 2>/dev/null; rm -f "$COOKIE"
echo 'процесс погашен'
