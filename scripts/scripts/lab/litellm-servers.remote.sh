#!/usr/bin/env bash
set -u
ENVF=/home/wfm/verme-ai-labs/deploy/stack/litellm/litellm.env
MASTER=$(grep -E '^LITELLM_MASTER_KEY=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
curl -sS -m 30 -H "Authorization: Bearer $MASTER" "http://127.0.0.1:4000/v1/mcp/server" > /tmp/mcp-servers.json
echo "size: $(wc -c < /tmp/mcp-servers.json)"
python3 - <<'PY'
import json
data = json.load(open('/tmp/mcp-servers.json'))
items = data if isinstance(data, list) else data.get('data') or data.get('servers') or []
print('серверов:', len(items))
for s in items:
    if not isinstance(s, dict):
        continue
    print('| id=', s.get('server_id') or s.get('id'), '| name=', s.get('server_name') or s.get('name'), '| groups=', s.get('mcp_access_groups') or s.get('access_groups'), '| url=', (s.get('url') or '')[:60])
PY
