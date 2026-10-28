/**
 * paths — кроссплатформенные проверки путей конфига плагина.
 *
 * Зачем отдельный модуль: конфиг приходит из-под двух платформ (DSH_HOME = /home/u/.dsh на
 * POSIX и C:\\Users\\u\\.dsh на Windows), а node:path судит по платформе процесса. Проверки
 * вида path.startsWith('/') и path.startsWith(dshHome + '/') на Windows отвергают собственный
 * дефолт плагина: stateFile = C:\\...\\.dsh\\storages\\... не начинается с '/', поэтому
 * validatePath возвращал '', routesEnabled=false, и ни страница /verme-gate, ни её API не
 * поднимались (симптом: «Плагин не отвечает. HTTP 404» при работающей клиентской половине).
 *
 * Правило: вид пути определяем по САМОЙ СТРОКЕ (диск/UNC → win32, иначе posix) и сравниваем
 * путём relative(), а не префиксом строки — префикс ловит /home/u/.dsh-другой как «внутри».
 */
import { win32, posix } from 'node:path'

/** Полный Windows-путь с диском: C:\\..., C:/... */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/
/** UNC-путь: \\\\server\\share */
const WIN_UNC = /^\\\\[^\\]/

/**
 * Вид пути по его строке: 'win32' для диска/UNC, 'posix' для всего остального.
 * @param {unknown} value - проверяемое значение.
 * @returns {'win32'|'posix'|''} вид пути ('' — не строка или пусто).
 */
export function pathFlavour(value) {
  if (typeof value !== 'string' || value === '') return ''
  if (WIN_DRIVE.test(value) || WIN_UNC.test(value)) return 'win32'
  return 'posix'
}

/**
 * API путей под конкретную строку: win32-правила применяются к Windows-пути и на Linux.
 * @param {unknown} value - путь.
 * @returns {object} модуль win32 или posix из node:path.
 */
export function pathApi(value) {
  return pathFlavour(value) === 'win32' ? win32 : posix
}

/**
 * Абсолютный ли путь. Требуем полный путь, а не «от корня текущего диска»: \\foo и C:foo
 * относительны по смыслу и зависят от CWD процесса, поэтому абсолютными не считаются.
 * @param {unknown} value - проверяемое значение.
 * @returns {boolean} true — путь абсолютный.
 */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (pathFlavour(value) === 'win32') return WIN_DRIVE.test(value) || WIN_UNC.test(value)
  return posix.isAbsolute(value)
}

/**
 * Лежит ли путь внутри каталога (равен ему или глубже). Регистр на Windows не важен, диск — важен.
 * @param {unknown} candidate - проверяемый путь.
 * @param {unknown} base - каталог-основание.
 * @returns {boolean} true — внутри.
 */
export function isInsideDir(candidate, base) {
  const flavour = pathFlavour(candidate)
  if (flavour === '' || pathFlavour(base) !== flavour) return false
  const api = flavour === 'win32' ? win32 : posix
  const rel = api.relative(base, candidate)
  if (rel === '' || rel === '.') return true
  // Другой диск на Windows: relative отдаёт абсолютный путь, а не '..\\...'.
  if (api.isAbsolute(rel)) return false
  return rel.split(api.sep)[0] !== '..'
}

/**
 * Проверить и принять путь из конфига: абсолютный, stateFile — внутри DSH_HOME,
 * журнал — где угодно (с предупреждением).
 * @param {object} options - параметры проверки.
 * @param {unknown} options.value - значение из конфига.
 * @param {string} options.fallback - значение по умолчанию.
 * @param {string} options.label - имя поля для сообщения.
 * @param {boolean} options.insideHome - требовать ли расположения внутри DSH_HOME.
 * @param {string} options.dshHome - каталог DSH.
 * @param {string[]} options.errors - приёмник ошибок конфига.
 * @param {string[]} options.warnings - приёмник предупреждений.
 * @returns {string} принятый путь ('' — ошибка конфига).
 */
export function validatePathValue(options) {
  const { value, fallback, label, insideHome, dshHome, errors, warnings } = options
  const path = typeof value === 'string' && value !== '' ? value : fallback
  if (path === '') return ''
  if (!isAbsolutePath(path)) {
    errors.push(label + ' "' + path + '" должен быть абсолютным путём (относительный зависит от CWD процесса)')
    return ''
  }
  if (insideHome === true && !isInsideDir(path, dshHome)) {
    errors.push(label + ' "' + path + '" должен лежать внутри DSH_HOME (' + dshHome + ')')
    return ''
  }
  if (insideHome !== true && !isInsideDir(path, dshHome)) {
    warnings.push(label + ' "' + path + '" вне DSH_HOME — пишем туда, куда указал оператор')
  }
  return path
}
