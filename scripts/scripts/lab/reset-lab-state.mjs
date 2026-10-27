import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/home/seva/dsh-prod021-pkg/node_modules/')
const YAML = require('js-yaml')

const home = '/home/seva/.dsh-lab-3090'
const credsPath = home + '/.credentials.yaml'
const statePath = home + '/storages/dsh-mcp-access.json'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

if (!existsSync(credsPath)) {
  console.log('нет файла credentials:', credsPath)
  process.exit(1)
}
copyFileSync(credsPath, credsPath + '.bak-reset-' + stamp)
const doc = YAML.load(readFileSync(credsPath, 'utf8')) || {}
const removedRefs = []
const refs = doc.refs || {}
for (const key of Object.keys(refs)) {
  if (key.startsWith('MCP_ACCESS_')) {
    removedRefs.push(key)
    delete refs[key]
  }
}
const removedRecords = []
const records = doc.records || {}
for (const key of Object.keys(records)) {
  if (key.startsWith('client-connection/')) {
    removedRecords.push(key)
    delete records[key]
  }
}
doc.refs = refs
doc.records = records
writeFileSync(credsPath, YAML.dump(doc, { lineWidth: -1, noRefs: true }), { mode: 0o600 })

if (existsSync(statePath)) {
  copyFileSync(statePath, statePath + '.bak-reset-' + stamp)
  unlinkSync(statePath)
  console.log('удалён state активного токена:', statePath)
}
console.log('бэкап credentials:', credsPath + '.bak-reset-' + stamp)
console.log('снято ref-ов:', removedRefs.length, removedRefs.join(','))
console.log('снято сессий:', removedRecords.length, removedRecords.join(','))
