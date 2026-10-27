#!/usr/bin/env bash
# Живая проверка установленного verme-gate в отдельном доме: поднять DSH на порту, залогиниться
# по ?token=… из лога, проверить /verme-gate и /verme-gate/api/state, погасить процесс.
# Использование: check-dist-home.sh <DSH_HOME> <port> <log>
set -uo pipefail
HOME_DIR="$1"; PORT="$2"; LOG="$3"
NODE=/snap/node/current/bin/node
BIN=/home/seva/dsh-prod021-pkg/node_modules/@deepseek-ai/dsh/lib/bin.js

if [ ! -f "$HOME_DIR/profiles/web/package.json" ]; then echo "FAIL: нет профиля в $HOME_DIR"; exit 1; fi
rm -f "$LOG"
DSH_HOME="$HOME_DIR" setsid nohup "$NODE" "$BIN" --profile web --host 127.0.0.1 --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!
echo "pid=$PID port=$PORT home=$HOME_DIR"

TOKEN=""
for i in $(seq 1 60); do
  TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" | head -1 | cut -d= -f2)
  [ -n "$TOKEN" ] && break
  sleep 1
done
if [ -z "$TOKEN" ]; then echo "FAIL: token не появился в логе"; tail -20 "$LOG"; kill "$PID" 2>/dev/null; exit 1; fi
echo "token: получен из лога (значение не печатается)"

COOKIE=$(mktemp)
CODE_LOGIN=$(curl -s -m 30 --noproxy "*" -c "$COOKIE" -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/?token=$TOKEN")
echo "GET /?token=… -> $CODE_LOGIN"

for ROUTE in /verme-gate /verme-gate/api/state /verme-gate/api/diag; do
  SAFE=$(echo "$ROUTE" | tr "/" "_")
  CODE=$(curl -s -m 90 --noproxy "*" -b "$COOKIE" -o "/tmp/dist-route$SAFE.json" -w "%{http_code}" "http://127.0.0.1:$PORT$ROUTE")
  echo "GET $ROUTE -> $CODE"
done
$NODE -e 'const j=require("/tmp/dist-route_verme-gate_api_state.json"); const m=j.models||{}; console.log("  phase:",j.phase||"(нет)","| activeToken:",j.activeToken||"(нет)","| servers:",(j.servers||[]).length,"| keyState:",m.keyState||"(нет)")'

kill "$PID" 2>/dev/null
for i in $(seq 1 15); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
kill -9 "$PID" 2>/dev/null
rm -f "$COOKIE"
echo "процесс погашен"
