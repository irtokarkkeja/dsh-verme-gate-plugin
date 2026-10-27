import json
spec = json.load(open('/tmp/litellm-openapi.json'))
body = spec['paths']['/key/update']['post'].get('requestBody', {})
ref = body.get('content', {}).get('application/json', {}).get('schema', {}).get('$ref', '')
name = ref.split('/')[-1]
schema = spec['components']['schemas'].get(name, {})
props = schema.get('properties', {})
print('схема:', name, '| полей:', len(props))
for k, v in props.items():
    if 'permission' in k or 'mcp' in k or 'model' in k or 'budget' in k or 'metadata' in k or k == 'key':
        t = v.get('type') or v.get('anyOf') or v.get('allOf')
        desc = (v.get('description') or '')[:70]
        print(' -', k, '|', str(t)[:70], '|', desc)
