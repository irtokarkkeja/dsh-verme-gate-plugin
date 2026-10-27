import json
data = json.load(open('/tmp/litellm-keys.json'))
keys = data.get('keys', data)
one = None
for k in keys:
    if isinstance(k, dict) and k.get('key_alias') == 'badara-dugartsyrenov-dsh':
        one = k
        break
if one is None:
    print('не нашёл ключ коллеги')
else:
    print('metadata keys:', sorted((one.get('metadata') or {}).keys()))
    print('models:', json.dumps(one.get('models'), ensure_ascii=False))
    print('budget:', one.get('max_budget'), 'duration:', one.get('duration'), 'team:', one.get('team_id'))
    print('fields:', sorted(one.keys()))
