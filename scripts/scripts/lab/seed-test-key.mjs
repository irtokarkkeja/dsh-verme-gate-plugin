import { readFileSync } from 'node:fs'

const key = readFileSync('/home/seva/host/litellm-v-kolokolov-dsh-test.key', 'utf8').trim()
const base = 'http://127.0.0.1:3090'
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  return { status: res.status, payload, text: text.slice(0, 300) }
}

const seeded = await post('/mcp-access/api/token-key', { token: 'kolokolov-test', value: key })
console.log('token-key:', seeded.status, seeded.payload === null ? seeded.text : 'ok')
await new Promise((r) => setTimeout(r, 12000))
const res = await fetch(base + '/mcp-access/api/state')
const state = await res.json()
console.log('phase:', state.phase, '| lastError:', JSON.stringify(state.lastError).slice(0, 160))
for (const server of state.servers) {
  const tools = Array.isArray(server.mountedTools) ? server.mountedTools.length : 0
  console.log(' server', server.name, '|', server.status, '| tools:', tools, '| keyState:', server.keyState || '-')
}
const models = state.models
console.log('models.allowed:', models && models.allowed ? models.allowed.length : models)
console.log('agent gated:', state.agentsReport ? state.agentsReport.gated + '/' + state.agentsReport.candidates : '?')
