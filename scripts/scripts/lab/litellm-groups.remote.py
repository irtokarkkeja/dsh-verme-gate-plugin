import json
data = json.load(open('/tmp/litellm-keys.json'))
keys = data.get('keys', data)
def brief(k):
    return {
        'alias': k.get('key_alias'),
        'user_id': k.get('user_id'),
        'groups': k.get('access_group_ids'),
        'permissions': k.get('permissions'),
        'routes': k.get('allowed_routes'),
        'key_type': k.get('key_type'),
        'budget': k.get('max_budget'),
        'object_permission': k.get('object_permission'),
    }
for k in keys:
    if isinstance(k, dict) and k.get('key_alias') in ('badara-dugartsyrenov-dsh', 'bench-dshlab-a', 'dmitry-khamidulin-dsh'):
        print(json.dumps(brief(k), ensure_ascii=False))
