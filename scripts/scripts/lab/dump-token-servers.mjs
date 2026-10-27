const res = await fetch('http://127.0.0.1:3090/mcp-access/api/state')
const state = await res.json()
for (const t of state.tokens) {
  console.log('token', t.id, '| servers:', JSON.stringify(t.servers).slice(0, 200))
}
