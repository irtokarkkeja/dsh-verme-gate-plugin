#!/usr/bin/env bash
set -u
ENVF=/home/wfm/verme-ai-labs/deploy/stack/litellm/litellm.env
MASTER=$(grep -E '^LITELLM_MASTER_KEY=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
KEY=$(cat /tmp/dsh-test-key.txt)

cat > /tmp/kolokolov-perm.json <<'JSON'
{
  "mcp_servers": ["22dc3c6f06f07a4e8877be86a0a20d51"],
  "mcp_access_groups": ["core", "common", "web"]
}
JSON

python3 - <<'PY' > /tmp/kolokolov-update-body.json
import json
perm = json.load(open('/tmp/kolokolov-perm.json'))
key = open('/tmp/dsh-test-key.txt').read().strip()
print(json.dumps({'key': key, 'object_permission': perm}))
PY

curl -sS -m 40 -X POST -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  --data @/tmp/kolokolov-update-body.json "http://127.0.0.1:4000/key/update" > /tmp/kolokolov-update-resp.json
echo "update: $(wc -c < /tmp/kolokolov-update-resp.json) байт"

echo '--- проверка ключом (models):'
curl -sS -m 30 -H "Authorization: Bearer $KEY" "http://127.0.0.1:4000/v1/models" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(sorted(m["id"] for m in d.get("data", []))))'

echo '--- проверка ключом (mcp servers):'
curl -sS -m 30 -H "Authorization: Bearer $KEY" "http://127.0.0.1:4000/v1/mcp/server" | python3 -c 'import json,sys; d=json.load(sys.stdin); items=d if isinstance(d,list) else d.get("data", []); print(len(items), "|", ", ".join(sorted((s.get("server_name") or s.get("name") or "") + "[" + ",".join(s.get("mcp_access_groups") or s.get("access_groups") or []) + "]" for s in items)))'

echo '--- object_permission из /key/info:'
curl -sS -m 30 -H "Authorization: Bearer $MASTER" "http://127.0.0.1:4000/key/info?key=$KEY" | python3 -c 'import json,sys; d=json.load(sys.stdin); i=d.get("info", d); print(json.dumps(i.get("object_permission"), ensure_ascii=False))'
