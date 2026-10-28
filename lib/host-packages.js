/**
 * Разрешение пакетов хоста DSH — то, что нельзя спросить у createRequire.
 *
 * Зачем отдельный модуль: драйверу маршрута моделей нужен ESM-only пакет
 * `@earendil-works/pi-ai` (exports "." объявлен только как import, условия require нет), поэтому
 * `createRequire().resolve` его не видит и точку входа приходится искать по exports-карте руками.
 *
 * Где искать — неочевидно и зависит от способа установки DSH:
 * - глобальный npm (`%APPDATA%\\npm\\node_modules`, `/usr/local/lib/node_modules`): сам пакет dsh и
 *   его зависимости могут лежать на одном уровне (`<prefix>/node_modules/@deepseek-ai/dsh`,
 *   `<prefix>/node_modules/@earendil-works/pi-ai`), а могут быть вложены ВНУТРЬ пакета dsh
 *   (`<prefix>/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai`) — так npm
 *   раскладывает зависимости при конфликте версий. Без второго варианта маршрут моделей не
 *   поднимался (Windows, 0.3.31), и в селекторе оставались только встроенные модели.
 * - отдельный checkout/dev-зеркало (`~/dsh-prod021-pkg`): корень установки и есть префикс.
 *
 * Используются пути текущей платформы. Тесты на Linux воспроизводят вложенность npm,
 * но не заменяют запуск на Windows.
 *
 * @module host-packages
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * Каталоги, где может лежать установка DSH-хоста. Набор обязан быть кроссплатформенным: на
 * Windows DSH стоит глобально в `%APPDATA%\\npm\\node_modules`, и POSIX-пути там ничего не находили
 * (следствие видно как `dsh.known: false` и как «пакет хоста не найден» на импорте undici).
 * @param {object} [overrides] - подмена окружения для тестов.
 * @param {NodeJS.ProcessEnv} [overrides.env] - окружение (по умолчанию process.env).
 * @param {string} [overrides.argv1] - точка входа процесса (по умолчанию process.argv[1]).
 * @param {string} [overrides.home] - домашний каталог (по умолчанию homedir()).
 * @param {string[]} [overrides.roots] - готовый список корней (тесты: без опоры на машину).
 * @returns {string[]} абсолютные каталоги-кандидаты (возможно несуществующие — фильтруют вызывающие).
 */
export function hostInstallRoots(overrides = {}) {
  if (Array.isArray(overrides.roots)) return [...new Set(overrides.roots.filter((root) => typeof root === 'string' && root !== ''))]
  const env = overrides.env !== undefined && overrides.env !== null ? overrides.env : process.env
  const argv1 = overrides.argv1 !== undefined ? overrides.argv1 : process.argv[1]
  const home = overrides.home !== undefined ? overrides.home : homedir()
  const roots = []
  /** Добавить кандидата, если он задан. */
  const push = (value) => {
    if (typeof value === 'string' && value !== '') roots.push(value)
  }
  push(env.DSH_PACKAGE_ROOT)
  if (typeof argv1 === 'string' && argv1 !== '') {
    const binDir = dirname(argv1)
    // .../node_modules/@deepseek-ai/dsh/lib → .../node_modules → префикс установки
    push(join(binDir, '..', '..', '..'))
    push(join(binDir, '..', '..', '..', '..'))
  }
  push(env.APPDATA && join(env.APPDATA, 'npm', 'node_modules'))
  push(env.ProgramFiles && join(env.ProgramFiles, 'nodejs', 'node_modules'))
  push(join(home, '.npm-global', 'lib', 'node_modules'))
  push('/usr/local/lib/node_modules')
  // dev-зеркала этого хоста: полный checkout DSH для лабораторных прогонов плагина
  push(join(home, 'dsh-prod021-pkg'))
  push('/home/seva/dsh-prod021-pkg')
  return [...new Set(roots)]
}

/**
 * Каталог пакета @deepseek-ai/dsh, если он лежит рядом с известным корнем установки.
 * @param {string} root - корень установки (<prefix>, <prefix>/node_modules или сам каталог пакета).
 * @returns {string[]} существующие каталоги пакета dsh (0, 1 или 2 варианта).
 */
function dshPackageDirs(root) {
  const candidates = [
    join(root, 'node_modules', '@deepseek-ai', 'dsh'),
    join(root, '@deepseek-ai', 'dsh'),
  ]
  return candidates.filter((dir) => existsSync(join(dir, 'package.json')))
}

/**
 * Каталог пакета @deepseek-ai/dsh рядом с уже резолвнутым пакетом хоста: поднимаемся по предкам и
 * на каждом node_modules проверяем @deepseek-ai/dsh. Поиск по подстроке '/node_modules/@deepseek-ai/'
 * был POSIX-only — на Windows (обратные слэши) не находил ничего, и версия DSH оставалась неизвестной.
 * @param {string} entryPath - абсолютный путь к файлу входа пакета-соседа.
 * @returns {string} каталог пакета dsh ('' — не нашли).
 */
export function findHostDshDir(entryPath) {
  if (typeof entryPath !== 'string' || entryPath === '') return ''
  let dir = dirname(entryPath)
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(dir) === 'node_modules') {
      const candidate = join(dir, '@deepseek-ai', 'dsh')
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** Пакеты активного DSH проверяются раньше запасных установок. */
export function hostNodeModulesDirs(overrides = {}) {
  const dirs = []
  const argv1 = overrides.argv1 !== undefined ? overrides.argv1 : process.argv[1]
  let entry = argv1
  try { if (entry) entry = realpathSync(entry) } catch { /* резервные корни ниже */ }
  const active = overrides.dshDir || findHostDshDir(entry)
  if (active) {
    dirs.push(join(active, 'node_modules'))
    let dir = active
    while (true) {
      if (basename(dir) === 'node_modules') dirs.push(dir)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  for (const root of hostInstallRoots(overrides)) {
    for (const dshDir of dshPackageDirs(root)) dirs.push(join(dshDir, 'node_modules'))
    dirs.push(join(root, 'node_modules'), root)
  }
  if (entry) dirs.push(join(dirname(entry), '..', 'node_modules'), join(dirname(entry), 'node_modules'))
  return [...new Set(dirs)].filter((dir) => existsSync(dir))
}

/** Условия ESM Node; порядок ключей в exports задаёт приоритет. undefined означает неизвестное условие. */
function conditionalTarget(value) {
  if (typeof value === 'string') {
    if (!value.startsWith('./') || value.includes('\\') || value.split('/').some((part) => part === '..' || part === 'node_modules') || /%2f|%5c|%2e/i.test(value)) {
      throw Object.assign(new Error('Invalid package export target'), { code: 'ERR_INVALID_PACKAGE_TARGET' })
    }
    return value
  }
  if (value === null) return null
  if (Array.isArray(value)) {
    let last = null
    for (const option of value) {
      try {
        const result = conditionalTarget(option)
        if (result === undefined) continue
        if (result === null) { last = null; continue }
        return result
      } catch (error) {
        if (error.code !== 'ERR_INVALID_PACKAGE_TARGET') throw error
        last = error
      }
    }
    if (last) throw last
    return null
  }
  if (value && typeof value === 'object') {
    for (const [condition, option] of Object.entries(value)) {
      if (!['node', 'import', 'default'].includes(condition)) continue
      const result = conditionalTarget(option)
      if (result !== undefined) return result
    }
  }
  return undefined
}

/** Разрешённый подпуть exports без обхода закрытого API через main/index.js. */
function exportedTarget(pkg, wanted) {
  const map = pkg.exports
  if (map === undefined) return wanted === '.' ? (pkg.module || pkg.main || './index.js') : undefined
  if (typeof map === 'string' || map === null || Array.isArray(map)) return wanted === '.' ? conditionalTarget(map) : undefined
  const keys = Object.keys(map)
  if (!keys.some((key) => key.startsWith('.'))) return wanted === '.' ? conditionalTarget(map) : undefined
  if (Object.hasOwn(map, wanted)) return conditionalTarget(map[wanted])
  const patterns = keys.filter((key) => key.includes('*')).sort((a,b) =>
    b.indexOf('*') - a.indexOf('*') || b.length - a.length)
  for (const key of patterns) {
    const [prefix, suffix] = key.split('*')
    if (!wanted.startsWith(prefix) || !wanted.endsWith(suffix) || wanted.length < prefix.length + suffix.length) continue
    const middle = wanted.slice(prefix.length, wanted.length - suffix.length)
    const target = conditionalTarget(map[key])
    return typeof target === 'string' ? target.replaceAll('*', middle) : target
  }
  return undefined
}

/** Возвращает каталог выбранной копии пакета и file URL её точки входа. packageDir закрепляет подпути за этой копией. */
export function resolveHostPackage(spec, subpath = '', overrides = {}) {
  const wanted = subpath === '' ? '.' : './' + subpath
  const dirs = hostNodeModulesDirs(overrides)
  let packageDir = overrides.packageDir
  if (!packageDir) {
    for (const dir of dirs) {
      const candidate = join(dir, spec)
      if (existsSync(join(candidate, 'package.json'))) { packageDir = realpathSync(candidate); break }
    }
  }
  if (!packageDir) throw new Error('verme-gate: cannot locate ESM package "' + spec + '" (искали в ' + dirs.join(', ') + ')')
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const target = exportedTarget(pkg, wanted)
  if (typeof target !== 'string') throw new Error('Package export not available: ' + spec + ' ' + wanted + ' in ' + packageDir)
  // exports допускает только ./ внутри пакета; legacy main/module допускает имя без ./.
  const normalized = target.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if ((pkg.exports !== undefined && !target.startsWith('./')) || segments.includes('..')
      || segments.includes('node_modules') || /%2f|%5c|%2e/i.test(target) || target.startsWith('/') || /^[a-z]:/i.test(target)) {
    throw new Error('Invalid package export target: ' + spec + ' ' + wanted)
  }
  const entry = join(packageDir, target)
  if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error('Package entry missing: ' + entry)
  return { packageDir, entryUrl: pathToFileURL(entry).href }
}

/** Совместимый интерфейс для импорта ESM-only зависимости. */
export function hostModuleUrl(spec, subpath = '', overrides = {}) {
  return resolveHostPackage(spec, subpath, overrides).entryUrl
}
