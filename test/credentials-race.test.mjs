/**
 * Негативный инвариант гонки: несколько процессов пишут разные ref'ы в один credential-store.
 * Правильное поведение — ни одна запись не теряется (блокировка штатного store + перечитывание
 * файла перед записью); то, что было до фикса, — последний писатель затирает чужие ref'ы.
 *
 * Тест живой: настоящие файлы, настоящие процессы, настоящая блокировка из поставки DSH.
 * Пакеты хоста ищутся в обычных местах; не нашли — тест пропускается (offline-окружение).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const run = promisify(execFile)

/** Найти файл входа пакета хоста: env-подсказка, затем резолв от дерева DSH (как hostResolve в плагине). */
const hostEntry = async (spec, envName) => {
  const hint = process.env[envName]
  if (typeof hint === 'string' && hint !== '') return pathToFileURL(hint).href
  // Кандидаты без хардкода чужой машины: env-подсказка, dev-зеркало в домашнем каталоге, профиль DSH.
  const bases = [
    process.env.DSH_PACKAGE_ROOT ? join(process.env.DSH_PACKAGE_ROOT, 'package.json') : '',
    join(homedir(), 'dsh-prod021-pkg', 'package.json'),
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/web/package.json'),
  ].filter((base) => typeof base === 'string' && base !== '')
  for (const base of bases) {
    try {
      const resolved = createRequire(base).resolve(spec)
      await readFile(resolved, 'utf8')
      return pathToFileURL(resolved).href
    } catch {
      continue
    }
  }
  return ''
}

test('две параллельные записи в один store не теряют чужие ref\'ы', async (t) => {
  const atomicUrl = await hostEntry('@deepseek-ai/dsh-atomic-write', 'DSH_ATOMIC_WRITE')
  const yamlUrl = await hostEntry('yaml', 'DSH_YAML')
  if (atomicUrl === '' || yamlUrl === '') {
    t.skip('нет пакетов хоста (atomic-write/yaml) — проверка гонки возможна только на хосте с DSH')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'verme-gate-race-'))
  const file = join(dir, '.credentials.yaml')
  await writeFile(file, 'version: 1\nrefs:\n  BASE: keep\n', { mode: 0o600 })
  try {
    const writer = fileURLToPath(new URL('helpers/ref-writer.mjs', import.meta.url))
    const env = { ...process.env, VERME_GATE_ATOMIC_URL: atomicUrl, VERME_GATE_YAML_URL: yamlUrl }
    // Два независимых процесса по 25 итераций: окно гонки — перекрытие read-modify-write.
    await Promise.all([
      run(process.execPath, [writer, file, 'MCP_ACCESS_A', '25'], { env }),
      run(process.execPath, [writer, file, 'MCP_ACCESS_B', '25'], { env }),
    ])
    const text = await readFile(file, 'utf8')
    const yaml = await import(yamlUrl)
    const document = yaml.parse(text)
    assert.equal(document.refs.BASE, 'keep', 'чужой ref обязан выжить')
    assert.equal(document.refs.MCP_ACCESS_A, 'v24', 'последняя запись писателя A')
    assert.equal(document.refs.MCP_ACCESS_B, 'v24', 'последняя запись писателя B')
    const leftovers = (await import('node:fs/promises')).readdir
    assert.deepEqual((await leftovers(dir)).filter((name) => name !== '.credentials.yaml'), [], 'лишних файлов (tmp/lock) не осталось')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
