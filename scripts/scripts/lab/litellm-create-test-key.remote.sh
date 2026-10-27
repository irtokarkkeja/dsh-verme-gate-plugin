#!/usr/bin/env bash
set -u
ENVF=/home/wfm/verme-ai-labs/deploy/stack/litellm/litellm.env
MASTER=$(grep -E '^LITELLM_MASTER_KEY=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
if [ -z "${MASTER:-}" ]; then echo "нет мастер-ключа"; exit 1; fi

cat > /tmp/kolokolov-body.json <<'JSON'
{
  "key_alias": "v-kolokolov-dsh-test",
  "user_id": "v.kolokolov@verme.ru",
  "models": ["GeneralPurpose", "deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash"],
  "max_budget": 10,
  "metadata": {"purpose": "dsh-mcp-access lab test", "mirror": "colleague-dsh"}
}
JSON

curl -sS -m 40 -X POST -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  --data @/tmp/kolokolov-body.json "http://127.0.0.1:4000/key/generate" > /tmp/kolokolov-resp.json
echo "ответ: $(wc -c < /tmp/kolokolov-resp.json) байт"

python3 - <<'PY'
import json, hashlib, os
resp = json.load(open('/tmp/kolokolov-resp.json'))
key = resp.get('key') or resp.get('token') or ''
if not key:
    print('ОШИБКА создания:', json.dumps(resp, ensure_ascii=False)[:500])
    raise SystemExit(1)
info = resp.get('key_info') or {}
open('/tmp/dsh-test-key.txt', 'w').write(key)
os.chmod('/tmp/dsh-test-key.txt', 0o600)
fp = hashlib.sha256(key.encode()).hexdigest()[:12]
print('создан ключ:', info.get('key_alias') or resp.get('key_alias'), '| user:', info.get('user_id') or resp.get('user_id'))
print('fp sha256[:12]:', fp, '| длина:', len(key))
print('object_permission:', json.dumps(info.get('object_permission'), ensure_ascii=False)[:300])
PY
