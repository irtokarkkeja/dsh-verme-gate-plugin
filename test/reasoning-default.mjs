// Проверка ручки defaultReasoningEffort: профиль маршрута объявляет нужный уровень,
// а не жёсткий 'low', и мусор в конфиге не ломает маршрут.
//
// Запуск: node test/reasoning-default.mjs

import assert from 'node:assert/strict'
import { buildGatewayRoute, DEFAULT_REASONING_EFFORT, THINKING_LEVELS, GATEWAY_API } from '../lib/gateway-route.js'

/** Фейки ровно в объёме, который трогает buildGatewayRoute. */
const makeStubs = () => {
  const captured = {}
  const piAi = {
    lazyApi: () => () => {},
    InMemoryCredentialStore: class {},
    createProvider: (spec) => ({ spec, getModels: () => [] }),
  }
  const dshPi = {
    PiAiAdapter: class {
      constructor(options) {
        captured.adapterOptions = options
      }
    },
  }
  const dshLlm = { resolveRetryPolicy: () => ({ mode: 'normal' }) }
  return { captured, piAi, dshPi, dshLlm }
}

/** Собрать маршрут и вытащить уровень из профиля, который увидит адаптер. */
const profileReasoning = (reasoning) => {
  const { captured, piAi, dshPi, dshLlm } = makeStubs()
  buildGatewayRoute({
    piAi,
    loadApi: async () => ({}),
    dshPi,
    dshLlm,
    providerId: 'dshlab',
    displayName: 'test',
    baseUrl: 'https://example.invalid/v1',
    resolveKey: async () => 'k',
    modelCatalog: () => [{ id: 'GeneralPurpose' }],
    log: () => {},
    ...(reasoning === undefined ? {} : { reasoning }),
  })
  const profiles = captured.adapterOptions.profiles()
  return profiles.get('dshlab').reasoning
}

assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
assert.equal(DEFAULT_REASONING_EFFORT, 'medium')
assert.equal(profileReasoning(undefined), 'medium', 'без опции профиль должен объявлять medium')
assert.equal(profileReasoning('high'), 'high', 'явный уровень пробрасывается как есть')
assert.equal(profileReasoning('off'), 'off', 'off — валидный уровень (шлётся как минимальный)')
assert.equal(profileReasoning('nonsense'), 'medium', 'мусор в конфиге откатывается на дефолт')
assert.equal(profileReasoning(''), 'medium', 'пустая строка откатывается на дефолт')
assert.notEqual(profileReasoning(undefined), 'low', 'прошлый жёсткий low не должен вернуться')

// Профиль обязан остаться обслуживаемым: api маршрута и ёмкости на месте.
const { captured, piAi, dshPi, dshLlm } = makeStubs()
const route = buildGatewayRoute({
  piAi,
  loadApi: async () => ({}),
  dshPi,
  dshLlm,
  providerId: 'dshlab',
  displayName: 'test',
  baseUrl: 'https://example.invalid/v1',
  resolveKey: async () => 'k',
  modelCatalog: () => [{ id: 'GeneralPurpose', contextWindow: 1048576, maxTokens: 32768 }],
  log: () => {},
})
const profile = captured.adapterOptions.profiles().get('dshlab')
assert.equal(profile.api, GATEWAY_API)
assert.equal(profile.defaultContextWindow, 131072)
assert.equal(profile.defaultMaxTokens, 32768)
assert.equal(profile.configuredMaxTokens.get('GeneralPurpose'), 32768)
const described = route.describe()
assert.equal(described.reasoning, 'medium')
assert.equal(described.models, 1)

console.log('reasoning-default: 12 проверок пройдено (дефолт medium, откат мусора, профиль обслуживаем)')
