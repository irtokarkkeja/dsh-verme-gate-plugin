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
import { existsSync, readFileSync } from 'node:fs'
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

/**
 * Каталоги node_modules хоста, где искать пакет вручную. Порядок = приоритет: сначала префикс
 * установки, затем сам каталог пакета dsh (там npm держит вложенные зависимости), затем то, что
 * выводится из точки входа процесса.
 * @param {object} [overrides] - подмена окружения для тестов (см. hostInstallRoots).
 * @returns {string[]} абсолютные пути существующих каталогов node_modules.
 */
export function hostNodeModulesDirs(overrides = {}) {
  const dirs = []
  for (const root of hostInstallRoots(overrides)) {
    dirs.push(join(root, 'node_modules'))
    dirs.push(join(root))
    // Вложенные зависимости самого пакета dsh: глобальная npm-установка кладёт ESM-only pi-ai
    // внутрь пакета, а не рядом с ним — иначе маршрут моделей молча не встаёт.
    for (const dshDir of dshPackageDirs(root)) dirs.push(join(dshDir, 'node_modules'))
  }
  const argv1 = overrides.argv1 !== undefined ? overrides.argv1 : process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    dirs.push(join(dirname(argv1), 'node_modules'))
    dirs.push(join(dirname(argv1), '..'))
    dirs.push(join(dirname(argv1), '..', 'node_modules'))
    // Точка входа может сама указывать внутрь установки, которой нет среди корней.
    const dshDir = findHostDshDir(argv1)
    if (dshDir !== '') dirs.push(join(dshDir, 'node_modules'))
  }
  return [...new Set(dirs)].filter((dir) => existsSync(dir))
}

/**
 * Собрать file:// URL модуля ESM-only пакета по его exports-карте (без createRequire).
 * @param {string} spec - имя пакета ('@scope/name').
 * @param {string} [subpath] - подпуть без './' ('api/openai-completions'); '' — корень пакета.
 * @param {object} [overrides] - подмена окружения для тестов (см. hostInstallRoots).
 * @returns {string} file:// URL точки входа.
 * @throws {Error} если пакета нет ни в одном найденном node_modules (в тексте — что искали).
 */
export function hostModuleUrl(spec, subpath = '', overrides = {}) {
  const wanted = subpath === '' ? '.' : './' + subpath
  const dirs = hostNodeModulesDirs(overrides)
  for (const dir of dirs) {
    const packageDir = join(dir, spec)
    if (!existsSync(join(packageDir, 'package.json'))) continue
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const exportsMap = pkg.exports
    let target = ''
    if (typeof exportsMap === 'string') target = exportsMap
    else if (exportsMap !== null && typeof exportsMap === 'object') {
      const entry = exportsMap[wanted]
      if (typeof entry === 'string') target = entry
      else if (entry !== null && typeof entry === 'object') target = entry.import || entry.default || ''
      if (target === '') {
        for (const key of Object.keys(exportsMap)) {
          if (!key.includes('*')) continue
          const [prefix, suffix] = key.split('*')
          if (!wanted.startsWith(prefix) || !wanted.endsWith(suffix)) continue
          const middle = wanted.slice(prefix.length, wanted.length - suffix.length)
          const value = exportsMap[key]
          const pattern = typeof value === 'string' ? value : (value && (value.import || value.default)) || ''
          if (pattern !== '') target = pattern.split('*').join(middle)
          break
        }
      }
    }
    if (target === '' && wanted === '.') target = pkg.module || pkg.main || './index.js'
    if (target === '') continue
    return pathToFileURL(join(packageDir, target)).href
  }
  throw new Error('verme-gate: cannot locate ESM package "' + spec + (subpath === '' ? '' : '/' + subpath)
    + '" in host node_modules (искали в ' + dirs.length + ': ' + dirs.join(', ') + ')')
}
