#!/usr/bin/env bash
set -u
ENVF=/home/wfm/verme-ai-labs/deploy/stack/litellm/litellm.env
MASTER=$(grep -E '^LITELLM_MASTER_KEY=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
if [ -z "${MASTER:-}" ]; then echo "нет мастер-ключа в $ENVF"; exit 1; fi
curl -sS -m 30 -H "Authorization: Bearer $MASTER" "http://127.0.0.1:4000/key/list?return_full_object=true" > /tmp/litellm-keys.json
echo "byte size: $(wc -c < /tmp/litellm-keys.json)"
python3 - <<'PY'
import json
data = json.load(open('/tmp/litellm-keys.json'))
keys = data.get('keys') or data if isinstance(data, list) else data.get('keys', [])
if isinstance(keys, dict):
    keys = keys.get('keys', [])
print('всего ключей:', len(keys))
rows = []
for k in keys:
    if not isinstance(k, dict):
        continue
    meta = k.get('metadata') or {}
    rows.append({
        'alias': k.get('key_alias') or k.get('alias') or '',
        'user': k.get('user_id') or meta.get('user_id') or '',
        'team': k.get('team_id') or '',
        'models': k.get('models') or [],
        'groups': meta.get('access_groups') or meta.get('access_group') or meta.get('mcp_servers') or [],
        'budget': k.get('max_budget'),
        'spend': k.get('spend'),
    })
rows.sort(key=lambda r: r['alias'])
for r in rows:
    print('|', r['alias'], '| user=', r['user'], '| team=', r['team'], '| models=', ','.join(map(str, r['models']))[:80], '| groups=', json.dumps(r['groups'], ensure_ascii=False)[:120], '| budget=', r['budget'])
PY
