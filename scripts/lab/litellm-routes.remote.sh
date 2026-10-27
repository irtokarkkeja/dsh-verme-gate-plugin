#!/usr/bin/env bash
set -u
ENVF=/home/wfm/verme-ai-labs/deploy/stack/litellm/litellm.env
MASTER=$(grep -E '^LITELLM_MASTER_KEY=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
curl -sS -m 30 -H "Authorization: Bearer $MASTER" "http://127.0.0.1:4000/openapi.json" > /tmp/litellm-openapi.json
python3 - <<'PY'
import json
spec = json.load(open('/tmp/litellm-openapi.json'))
paths = sorted(spec.get('paths', {}).keys())
print('version:', spec.get('info', {}).get('version'))
for p in paths:
    if 'key' in p or 'permission' in p or 'mcp' in p:
        methods = ','.join(sorted(m.upper() for m in spec['paths'][p]))
        print(methods, p)
PY
