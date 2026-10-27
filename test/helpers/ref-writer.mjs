/**
 * Помощник теста гонки: пишет свой ref в общий credential-store под той же блокировкой, что плагин.
 * Запуск: node ref-writer.mjs <file> <ref> <count>; пути к yaml/atomic-write приходят в env
 * (VERME_GATE_YAML_URL / VERME_GATE_ATOMIC_URL), чтобы не зависеть от дерева node_modules.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { applyRefWithLock } from '../../lib/credentials-emergency.js'

const [file, ref, countRaw] = process.argv.slice(2)
const count = Number(countRaw)

const yaml = await import(process.env.VERME_GATE_YAML_URL)
const atomic = await import(process.env.VERME_GATE_ATOMIC_URL)

for (let index = 0; index < count; index += 1) {
  const result = await applyRefWithLock({
    withLock: (operation) => atomic.withFileLock(file, operation),
    readText: () => readFile(file, 'utf8').catch(() => ''),
    writeText: (text) => atomic.writeFileAtomic(file, text, { mode: 0o600 }),
    parse: (text) => yaml.parse(text),
    stringify: (document) => yaml.stringify(document),
    ref,
    value: 'v' + index,
  })
  if (!result.ok) {
    console.error('writer failed: ' + result.error)
    process.exit(1)
  }
}
console.log('ok ' + ref + ' x' + count)
