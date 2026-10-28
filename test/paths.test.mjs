/**
 * Пути плагина: один и тот же код обязан принимать POSIX- и Windows-конфиг.
 *
 * Регрессия, которую эти тесты держат: проверки были POSIX-only (path.startsWith('/') и
 * path.startsWith(dshHome + '/')). На Windows (DSH_HOME = C:\\Users\\<user>\\.dsh) дефолтный
 * stateFile не проходил валидацию, routesEnabled становился false, и ни /verme-gate, ни её API
 * не поднимались — клиентская половина при этом грузилась и показывала «Плагин не отвечает.
 * HTTP 404». Windows-пути проверяются на Linux: вид пути определяется по строке, не по платформе.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolutePath, isInsideDir, pathFlavour, validatePathValue } from '../lib/paths.js'

const WIN_HOME = 'C:\\Users\\dreamer\\.dsh'
const WIN_STATE = 'C:\\Users\\dreamer\\.dsh\\storages\\dsh-mcp-access.json'
const POSIX_HOME = '/home/dreamer/.dsh'
const POSIX_STATE = '/home/dreamer/.dsh/storages/dsh-mcp-access.json'

/** Прогнать validatePathValue и вернуть всё, что она решила. */
const validate = (options) => {
  const errors = []
  const warnings = []
  const accepted = validatePathValue({ errors, warnings, ...options })
  return { accepted, errors, warnings }
}

test('вид пути определяется по строке: диск и UNC — win32, остальное — posix', () => {
  assert.equal(pathFlavour(WIN_STATE), 'win32')
  assert.equal(pathFlavour('C:/Users/dreamer/.dsh/x'), 'win32')
  assert.equal(pathFlavour('\\\\srv\\share\\x'), 'win32')
  assert.equal(pathFlavour(POSIX_STATE), 'posix')
  assert.equal(pathFlavour(''), '')
  assert.equal(pathFlavour(42), '')
})

test('абсолютность: полный Windows-путь и POSIX-путь — да, относительные — нет', () => {
  assert.equal(isAbsolutePath(WIN_STATE), true)
  assert.equal(isAbsolutePath('C:/Users/dreamer/.dsh/x'), true)
  assert.equal(isAbsolutePath('\\\\srv\\share\\x'), true)
  assert.equal(isAbsolutePath(POSIX_STATE), true)
  assert.equal(isAbsolutePath('storages/x.json'), false)
  assert.equal(isAbsolutePath('C:relative'), false, 'путь от текущего каталога диска — не абсолютный')
  assert.equal(isAbsolutePath('\\rooted-but-drive-relative'), false)
  assert.equal(isAbsolutePath(''), false)
})

test('внутри DSH_HOME: Windows-дефолт проходит, соседний каталог — нет', () => {
  assert.equal(isInsideDir(WIN_STATE, WIN_HOME), true, 'дефолт плагина обязан быть внутри дома')
  assert.equal(isInsideDir('C:\\Users\\dreamer\\.dsh-evil\\x.json', WIN_HOME), false, 'префикс соседа — не внутри')
  assert.equal(isInsideDir('C:\\Users\\dreamer\\.DSH\\storages\\x.json', WIN_HOME), true, 'регистр на Windows не важен')
  assert.equal(isInsideDir('D:\\Users\\dreamer\\.dsh\\x.json', WIN_HOME), false, 'другой диск — не внутри')
  assert.equal(isInsideDir(POSIX_STATE, POSIX_HOME), true)
  assert.equal(isInsideDir('/home/dreamer/.dsh2/x.json', POSIX_HOME), false, 'прежний startsWith ловил этот случай')
  assert.equal(isInsideDir(WIN_STATE, POSIX_HOME), false, 'смешанные виды путей не совместимы')
})

test('stateFile: дефолт Windows принимается без ошибок и предупреждений', () => {
  const result = validate({ value: undefined, fallback: WIN_STATE, label: 'stateFile', insideHome: true, dshHome: WIN_HOME })
  assert.equal(result.accepted, WIN_STATE)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('stateFile: путь вне DSH_HOME — ошибка конфига, путь не принят', () => {
  const result = validate({
    value: 'C:\\Temp\\state.json',
    fallback: WIN_STATE,
    label: 'stateFile',
    insideHome: true,
    dshHome: WIN_HOME,
  })
  assert.equal(result.accepted, '')
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /внутри DSH_HOME/)
})

test('logFile: вне DSH_HOME допустим, но даёт предупреждение', () => {
  const result = validate({
    value: 'C:\\Logs\\verme-gate.log',
    fallback: '',
    label: 'logFile',
    insideHome: false,
    dshHome: WIN_HOME,
  })
  assert.equal(result.accepted, 'C:\\Logs\\verme-gate.log')
  assert.deepEqual(result.errors, [])
  assert.equal(result.warnings.length, 1)
})

test('относительный путь отвергается и на Windows, и на POSIX', () => {
  for (const value of ['storages/state.json', '.\\state.json', 'C:state.json']) {
    const result = validate({ value, fallback: '', label: 'stateFile', insideHome: true, dshHome: WIN_HOME })
    assert.equal(result.accepted, '', 'путь ' + value + ' не должен приниматься')
    assert.match(result.errors[0], /абсолютным путём/)
  }
  const posix = validate({ value: 'storages/state.json', fallback: '', label: 'stateFile', insideHome: true, dshHome: POSIX_HOME })
  assert.equal(posix.accepted, '')
  assert.match(posix.errors[0], /абсолютным путём/)
})
