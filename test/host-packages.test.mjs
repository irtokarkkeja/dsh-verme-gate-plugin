/**
 * Тесты разрешения пакетов хоста: где искать ESM-only @earendil-works/pi-ai при разных способах
 * установки DSH. Windows-глобальная установка кладёт зависимости ВНУТРЬ пакета dsh — без этого
 * маршрут моделей молча не поднимался (0.3.31, «в селекторе только встроенные модели»).
 *
 * Раскладку строим в temp-каталоге и подсовываем модулю через overrides.roots — на машине тестов
 * не должно быть ни реального prefix, ни реального pi-ai.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { hostInstallRoots, hostNodeModulesDirs, hostModuleUrl, findHostDshDir } from '../lib/host-packages.js'

/** Каталог этого теста (не через url.pathname: на Windows он даёт /C:/...). */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Создать каталог с файлами: { 'относительный/путь': 'содержимое' }. */
function makeTree(base, files) {
  for (const [relative, text] of Object.entries(files)) {
    const target = join(base, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
}

/** Манифест pi-ai как у настоящего пакета: exports "." и подпуть api/openai-completions. */
const PI_AI_MANIFEST = JSON.stringify({
  name: '@earendil-works/pi-ai',
  version: '0.0.0-test',
  type: 'module',
  exports: {
    '.': { import: './dist/index.js' },
    './api/openai-completions': { import: './dist/api/openai-completions.js' },
  },
})
/** Манифест пакета dsh: нужен только как маркер «здесь установлен хост». */
const DSH_MANIFEST = JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' })

/** Временный каталог-стенд на один тест. */
function stand(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verme-hp-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('Windows-глобальная установка: pi-ai вложен внутрь пакета dsh и всё равно находится', (t) => {
  const prefix = stand(t)
  makeTree(prefix, {
    'node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json': PI_AI_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/index.js': 'export const ok = 1\n',
  })
  const dirs = hostNodeModulesDirs({ roots: [prefix] })
  const nested = join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
  assert.ok(dirs.includes(nested), 'каталог dsh/node_modules обязан быть в списке: ' + dirs.join(', '))
  const url = hostModuleUrl('@earendil-works/pi-ai', '', { roots: [prefix] })
  assert.ok(url.endsWith('/dist/index.js'), 'точка входа pi-ai: ' + url)
  assert.ok(url.startsWith('file://'))
})

test('корень .node_modules. (префикс установки) даёт тот же вложенный путь', (t) => {
  const prefix = stand(t)
  makeTree(prefix, {
    'node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json': PI_AI_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/index.js': '',
  })
  const nodeModules = join(prefix, 'node_modules')
  const url = hostModuleUrl('@earendil-works/pi-ai', '', { roots: [nodeModules] })
  assert.ok(fileURLToPath(url).includes(join('@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js')), url)
})

test('подпуть exports (api/openai-completions) разрешается из вложенного пакета', (t) => {
  const prefix = stand(t)
  makeTree(prefix, {
    'node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json': PI_AI_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js': '',
  })
  const url = hostModuleUrl('@earendil-works/pi-ai', 'api/openai-completions', { roots: [prefix] })
  assert.ok(url.endsWith('/dist/api/openai-completions.js'), url)
})

test('поднятая (hoisted) раскладка тоже работает: pi-ai рядом с dsh в префиксе', (t) => {
  const prefix = stand(t)
  makeTree(prefix, {
    'node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST,
    'node_modules/@earendil-works/pi-ai/package.json': PI_AI_MANIFEST,
    'node_modules/@earendil-works/pi-ai/dist/index.js': '',
  })
  const url = hostModuleUrl('@earendil-works/pi-ai', '', { roots: [prefix] })
  assert.ok(fileURLToPath(url).includes(join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js')), url)
})

test('точка входа процесса сама указывает внутрь установки, которой нет среди корней', (t) => {
  const fake = stand(t)
  makeTree(fake, {
    'node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST,
    'node_modules/@deepseek-ai/dsh/lib/bin.js': '',
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/package.json': PI_AI_MANIFEST,
    'node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/index.js': '',
  })
  const argv1 = join(fake, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dirs = hostNodeModulesDirs({ roots: [], argv1 })
  assert.ok(dirs.includes(join(dirname(argv1), '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
    || dirs.includes(join(fake, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')),
  'вложенный каталог не выведен из argv1: ' + dirs.join(', '))
  const url = hostModuleUrl('@earendil-works/pi-ai', '', { roots: [], argv1 })
  assert.ok(url.endsWith('/dist/index.js'), url)
})

test('findHostDshDir: подъём до node_modules, без POSIX-подстроки пути', (t) => {
  const fake = stand(t)
  makeTree(fake, {
    'node_modules/@deepseek-ai/dsh/package.json': DSH_MANIFEST,
    'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js': '',
  })
  const entry = join(fake, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js')
  assert.equal(findHostDshDir(entry), join(fake, 'node_modules', '@deepseek-ai', 'dsh'))
  assert.equal(findHostDshDir(''), '')
  assert.equal(findHostDshDir(join(fake, 'нет-такого', 'index.js')), '')
})

test('пакета нет ни в одном каталоге: ошибка перечисляет, где искали', (t) => {
  const prefix = stand(t)
  mkdirSync(join(prefix, 'node_modules'), { recursive: true })
  assert.throws(
    () => hostModuleUrl('@earendil-works/pi-ai', '', { roots: [prefix] }),
    (error) => error.message.includes('cannot locate ESM package') && error.message.includes('искали в'),
  )
})

test('hostInstallRoots: DSH_PACKAGE_ROOT идёт первым, дубликаты схлопываются', () => {
  const roots = hostInstallRoots({ env: { DSH_PACKAGE_ROOT: '/opt/dsh' }, argv1: '', home: '/home/x' })
  assert.equal(roots[0], '/opt/dsh')
  assert.equal(new Set(roots).size, roots.length)
  assert.ok(roots.includes(join('/home/x', 'dsh-prod021-pkg')))
  const forced = hostInstallRoots({ roots: ['/a', '/a', '/b'] })
  assert.deepEqual(forced, ['/a', '/b'])
  assert.equal(HERE.length > 0, true)
})
