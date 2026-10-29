import {test} from 'node:test'
import assert from 'node:assert/strict'
import {closure} from './helpers/closure.mjs'

/**
 * Стенд saveKeyAsToken: настоящий код index.js, подменены только хранилища и запись stateFile.
 * @param {object} control - управление сбоями записи.
 * @returns {object} зависимости, счётчики и запуск функции.
 */
function saveHarness(control) {
  const uiTokens = new Map()
  const catalog = {tokens: new Map()}
  const state = {activeToken: 'token-old'}
  const applied = []
  const unsets = []
  const sets = []
  const deps = {
    control,
    uiTokens,
    catalog,
    state,
    applied,
    unsets,
    sets,
    probeKey: async () => ({servers: [{name: 'srv'}], models: ['m1']}),
    readSecret: async () => '',
    applyActiveToken: async (reason, id) => {
      state.activeToken = id
      applied.push(id)
    },
    journal: () => {},
    credentialRef: (ref) => 'cred:' + ref,
    tokenKeyRef: (id) => 'key:' + id,
    slugTokenId: () => 'sso-key',
    TOKEN_ID_PATTERN: /^[a-z][a-z0-9-]{1,31}$/,
    uniqueTokenId: (id) => id,
    ctx: {
      credentials: {
        set: async (ref, value) => {
          sets.push([ref, value])
        },
        unset: async (ref) => {
          unsets.push(ref)
        },
      },
    },
    saveStateDoc: async () => {
      if (control.failSave) throw Object.assign(new Error('диск переполнен'), {code: 'ENOSPC'})
    },
    messageOf: (error) => String(error && error.message ? error.message : error),
  }
  return {deps, run: (key, options) => closure('saveKeyAsToken', deps)(key, options)}
}

test('сбой записи stateFile откатывает токен и секрет, а не оставляет фантом', async () => {
  const control = {failSave: true}
  const h = saveHarness(control)
  await assert.rejects(h.run('sk-live-abcdef', {label: 'SSO u@e', source: 'sso'}), (error) => {
    assert.equal(error.retryable, true, 'сбой записи временный: коннектор повторит')
    return true
  })
  assert.equal(h.deps.uiTokens.size, 0, 'токен не должен остаться в памяти')
  assert.equal(h.deps.catalog.tokens.size, 0)
  assert.equal(h.deps.unsets.length, 1, 'секрет несохранённого токена удалён')
  assert.equal(h.deps.state.activeToken, 'token-old', 'прежний доступ не тронут')
  assert.deepEqual(h.deps.applied, [])

  // Повтор после починки диска создаёт токен заново и включает его.
  control.failSave = false
  const saved = await h.run('sk-live-abcdef', {label: 'SSO u@e', source: 'sso'})
  assert.equal(saved.error, undefined)
  assert.equal(h.deps.uiTokens.size, 1)
  assert.equal(h.deps.state.activeToken, saved.token.id)
  assert.deepEqual(h.deps.applied, [saved.token.id])
})

test('activeToken не меняется, пока новый токен не записан на диск', async () => {
  const control = {failSave: false}
  const h = saveHarness(control)
  await h.run('sk-live-abcdef', {label: 'SSO u@e', source: 'sso'})
  assert.equal(h.deps.state.activeToken, h.deps.uiTokens.keys().next().value)
})

/**
 * Стенд commitActiveToken: saveActiveToken ведёт себя как в index.js (сначала память, потом диск).
 * @param {object} control - управление сбоями записи.
 * @returns {object} зависимости, состояние и запуск функции.
 */
function commitHarness(control) {
  const state = {activeToken: 'token-old'}
  const deps = {
    state,
    saveActiveToken: async (id) => {
      state.activeToken = id
      if (control.failSave) throw Object.assign(new Error('диск переполнен'), {code: 'ENOSPC'})
    },
  }
  return {deps, state, commit: (id) => closure('commitActiveToken', deps)(id)}
}

test('сбой персиста переключения возвращает прежний активный токен', async () => {
  const h = commitHarness({failSave: true})
  await assert.rejects(h.commit('token-new'), {code: 'ENOSPC'})
  assert.equal(h.state.activeToken, 'token-old', 'старый доступ должен остаться рабочим')
})

test('успешный персист оставляет новый активный токен', async () => {
  const h = commitHarness({failSave: false})
  await h.commit('token-new')
  assert.equal(h.state.activeToken, 'token-new')
})
