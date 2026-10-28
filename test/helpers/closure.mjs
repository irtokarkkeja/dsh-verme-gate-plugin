import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../../index.js', import.meta.url), 'utf8')
const newline = String.fromCharCode(10)
// Выполняется реальное тело функции; только динамические импорты заменяются загрузчиком стенда.
export function closure(name, dependencies, prefix = '') {
  const start = source.indexOf('  const ' + name + ' = ')
  if (start < 0) throw new Error('Нет функции ' + name)
  let stop = source.indexOf(newline + '  }', start) + 4
  if (source[stop] === ')') stop += 1
  const declaration = source.slice(start, stop).replaceAll('import(', 'loadModule(')
  return Function(...Object.keys(dependencies), prefix + newline + declaration + newline + 'return ' + name)(...Object.values(dependencies))
}
export function topLevelFunction(name, dependencies) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('Нет функции ' + name)
  const stop = source.indexOf(newline + '}', start) + 2
  return Function(...Object.keys(dependencies), source.slice(start, stop) + newline + 'return ' + name)(...Object.values(dependencies))
}
