/**
 * Негативные инварианты аварийной правки credential-store: модуль не должен ни терять чужие ref'ы,
 * ни перезаписывать битый YAML, ни врать про успех. Запуск: node --test test/credentials-emergency.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRefWithLock, mergeRef } from '../lib/credentials-emergency.js'

const sample = (refs) => ({ version: 1, refs })

const parse = (text) => {
  const document = { version: 1, refs: {} }
  for (const line of text.split('\n')) {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*): '(.*)'$/.exec(line)
    if (match !== null) document.refs[match[1]] = match[2]
  }
  return document
}

const stringify = (document) => ['version: ' + document.version, 'refs:']
  .concat(Object.entries(document.refs || {}).map(([key, value]) => "  " + key + ": '" + value + "'"))
  .join('\n') + '\n'

/** Хранилище в памяти + журнал операций: видно, что и в каком порядке писалось. */
const makeStore = (initial, hooks = {}) => {
  const state = { text: initial, writes: [], reads: 0, locked: 0 }
  const store = {
    state,
    readText: async () => {
      state.reads += 1
      const value = hooks.onRead ? await hooks.onRead(state, state.reads) : state.text
      return value === undefined ? state.text : value
    },
    writeText: async (text) => {
      if (hooks.beforeWrite) await hooks.beforeWrite(state)
      state.writes.push(text)
      state.text = text
    },
    withLock: async (fn) => {
      state.locked += 1
      return await fn()
    },
  }
  return store
}

test('чужой ref переживает нашу запись (базовый инвариант)', async () => {
  const store = makeStore(stringify(sample({ MCP_ACCESS_A: 'old', DEEPSEEK_API_KEY: 'keep-me' })))
  const result = await applyRefWithLock({ ...store, parse, stringify, ref: 'MCP_ACCESS_A', value: 'new' })
  assert.equal(result.ok, true)
  const document = parse(store.state.text)
  assert.equal(document.refs.MCP_ACCESS_A, 'new')
  assert.equal(document.refs.DEEPSEEK_API_KEY, 'keep-me')
})

test('снятие ref (пустое значение) удаляет только свой ключ', async () => {
  const store = makeStore(stringify(sample({ MCP_ACCESS_A: 'old', OTHER: 'x' })))
  const result = await applyRefWithLock({ ...store, parse, stringify, ref: 'MCP_ACCESS_A', value: '' })
  assert.equal(result.ok, true)
  const document = parse(store.state.text)
  assert.equal('MCP_ACCESS_A' in document.refs, false)
  assert.equal(document.refs.OTHER, 'x')
})

test('битый YAML не перезаписывается: ноль записей, ok=false', async () => {
  const broken = 'version: 1\nrefs: [unclosed\n'
  const store = makeStore(broken)
  const result = await applyRefWithLock({
    ...store,
    parse: () => { throw new Error('YAML parse error') },
    stringify,
    ref: 'MCP_ACCESS_A',
    value: 'x',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /не разбирается/)
  assert.equal(store.state.writes.length, 0)
  assert.equal(store.state.text, broken)
})

test('чтение выполняется ВНУТРИ блокировки (иначе гонка read-modify-write)', async () => {
  const order = []
  const store = makeStore(stringify(sample({ A: '1' })), {
    onRead: async () => { order.push('read') },
    beforeWrite: async () => { order.push('write') },
  })
  const withLock = async (fn) => { order.push('lock:in'); const out = await fn(); order.push('lock:out'); return out }
  await applyRefWithLock({ ...store, withLock, parse, stringify, ref: 'A', value: '2' })
  assert.deepEqual(order.slice(0, 2), ['lock:in', 'read'])
  assert.equal(order[order.length - 1], 'lock:out')
})

test('чужая запись перед нашей записью: файл перечитывается, чужой ref сохраняется', async () => {
  // Первое чтение — снимок без C; проверочное чтение перед записью — уже с C (чужой писатель успел).
  const withC = stringify(sample({ A: '1', B: 'b', C: 'written-by-other' }))
  const withoutC = stringify(sample({ A: '1', B: 'b' }))
  const store = makeStore(withoutC, {
    onRead: async (state, count) => (count === 2 ? withC : state.text),
  })
  store.state.text = withC
  const result = await applyRefWithLock({ ...store, parse, stringify, ref: 'A', value: '2' })
  assert.equal(result.ok, true)
  const document = parse(store.state.text)
  assert.equal(document.refs.A, '2')
  assert.equal(document.refs.C, 'written-by-other')
})

test('файл меняется на каждом чтении — честный отказ без записи', async () => {
  let counter = 0
  const store = makeStore(stringify(sample({ A: '1' })))
  store.state.text = stringify(sample({ A: '1' }))
  store.readText = async () => {
    counter += 1
    return stringify(sample({ A: '1', ['X' + counter]: 'v' }))
  }
  const result = await applyRefWithLock({ ...store, parse, stringify, ref: 'A', value: '2', attempts: 3 })
  assert.equal(result.ok, false)
  assert.match(result.error, /меняется под нами/)
  assert.equal(store.state.writes.length, 0)
})

test('readback mismatch (запись не применилась) — ok=false, не тихий успех', async () => {
  const store = makeStore(stringify(sample({ A: '1' })))
  store.writeText = async () => { /* писатель молча ничего не сделал */ }
  const result = await applyRefWithLock({ ...store, parse, stringify, ref: 'A', value: '2' })
  assert.equal(result.ok, false)
  assert.match(result.error, /readback mismatch/)
})

test('mergeRef не мутирует входной документ и не теряет прочие поля', () => {
  const document = { version: 1, refs: { A: '1' }, note: 'чужое поле' }
  const next = mergeRef(document, 'A', '2')
  assert.equal(document.refs.A, '1')
  assert.equal(next.refs.A, '2')
  assert.equal(next.note, 'чужое поле')
  assert.equal(next.version, 1)
})

test('пустой файл трактуется как пустой store, а не как ошибка', async () => {
  const store = makeStore('')
  const result = await applyRefWithLock({ ...store, parse, stringify, ref: 'A', value: 'x' })
  assert.equal(result.ok, true)
  assert.equal(parse(store.state.text).refs.A, 'x')
})
