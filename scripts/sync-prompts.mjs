/**
 * Сборка встроенных промптов: копирует предметные инструкции из deploy/dsh-bootstrap в пакет.
 *
 * Источник правды — `deploy/dsh-bootstrap/*.md` (там их правят и версионируют). В пакет они
 * попадают копиями, чтобы раздел «Промпты» работал без настройки promptsDir: поставил плагин —
 * список уже есть. Режим --check сверяет копии с источником и падает при расхождении (гейт для
 * релиза: не публикуем пакет со старыми копиями).
 */
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceDir = fileURLToPath(new URL('../../../deploy/dsh-bootstrap/', import.meta.url))
const targetDir = fileURLToPath(new URL('../prompts/', import.meta.url))
const checkOnly = process.argv.includes('--check')

const names = existsSync(sourceDir)
  ? (await readdir(sourceDir)).filter((name) => name.endsWith('.md')).sort()
  : []

if (names.length === 0) {
  // В опубликованном пакете monorepo-раскладки нет: сверять не с чем, копии уже внутри.
  // Падать из-за этого нельзя — иначе check:prompts ложно валит сборку у потребителя.
  const note = 'источник ' + sourceDir + ' недоступен (нет *.md)'
  if (checkOnly) {
    console.log(note + ' — сверка пропущена')
    process.exit(0)
  }
  console.error(note + ' — нечего копировать')
  process.exit(1)
}

if (checkOnly) {
  const drift = []
  for (const name of names) {
    const path = join(targetDir, name)
    if (!existsSync(path)) {
      drift.push(name + ' (нет копии)')
      continue
    }
    const [from, to] = await Promise.all([readFile(join(sourceDir, name)), readFile(path)])
    if (!from.equals(to)) drift.push(name + ' (копия отличается)')
  }
  if (drift.length > 0) {
    console.error('встроенные промпты расходятся с deploy/dsh-bootstrap:\n  ' + drift.join('\n  '))
    console.error('починить: node scripts/sync-prompts.mjs')
    process.exit(1)
  }
  console.log('встроенные промпты совпадают с источником (' + names.length + ' файлов)')
  process.exit(0)
}

await rm(targetDir, { recursive: true, force: true })
await mkdir(targetDir, { recursive: true })
for (const name of names) {
  const body = await readFile(join(sourceDir, name))
  await writeFile(join(targetDir, name), body)
}
console.log('встроено ' + names.length + ' промптов: ' + names.join(', '))
