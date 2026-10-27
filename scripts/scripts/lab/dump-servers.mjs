const res = await fetch('http://127.0.0.1:3090/mcp-access/api/state')
const state = await res.json()
console.log('servers:', state.servers.length)
for (const s of state.servers) {
  console.log(JSON.stringify({ name: s.name, status: s.status, configured: s.configured, inConfig: s.inConfig, tokenRef: s.tokenRef, toolAllow: s.toolAllow, mounted: (s.mountedTools || []).length, reason: String(s.reason || '').slice(0, 60) }))
}
