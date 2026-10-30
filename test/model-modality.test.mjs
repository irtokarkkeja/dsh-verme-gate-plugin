import assert from 'node:assert/strict'
import test from 'node:test'

import { readModelCapabilities } from '../lib/model-modality.js'
import { buildGatewayRoute } from '../lib/gateway-route.js'

test('vision приходит из model_info: так шлюз объявляет картинки у алиаса', () => {
  // Реальная запись /model/info для GeneralPurpose после объявления model_info.supports_vision:
  // ёмкостей шлюз не отдаёт вовсе, только флаг — запись обязана остаться в карте.
  const capabilities = readModelCapabilities({
    model_name: 'GeneralPurpose',
    litellm_params: { model: 'openrouter/deepseek/deepseek-v4.1-flash-1017' },
    model_info: { supports_vision: true },
  })
  assert.equal(capabilities.vision, true)
  assert.equal(capabilities.contextWindow, undefined)
  assert.equal(capabilities.maxTokens, undefined)
})

test('vision приходит из litellm_params: некоторые шлюзы дублируют флаг там', () => {
  const capabilities = readModelCapabilities({ litellm_params: { supports_vision: true } })
  assert.equal(capabilities.vision, true)
})

test('текстовая модель без флага остаётся текстовой', () => {
  for (const entry of [
    { litellm_params: { supports_vision: false } },
    { model_info: { supports_vision: false } },
    { model_info: {} },
    { model_info: null, litellm_params: null },
    {},
  ]) {
    assert.equal(readModelCapabilities(entry).vision, false, JSON.stringify(entry))
  }
})

test('ёмкости берутся из litellm_params, приоритет у них', () => {
  const capabilities = readModelCapabilities({
    litellm_params: { max_input_tokens: 360448, max_output_tokens: 131072 },
    model_info: { max_input_tokens: 1048576, max_output_tokens: 262144 },
  })
  assert.equal(capabilities.contextWindow, 360448)
  assert.equal(capabilities.maxTokens, 131072)
})

test('ёмкости из model_info, когда в litellm_params их нет: модели из БД', () => {
  const capabilities = readModelCapabilities({
    litellm_params: { model: 'openrouter/x' },
    model_info: { max_input_tokens: '200000', max_output_tokens: '8192', supports_vision: true },
  })
  assert.equal(capabilities.contextWindow, 200000)
  assert.equal(capabilities.maxTokens, 8192)
  assert.equal(capabilities.vision, true)
})

test('мусор вместо ёмкостей не превращается в лимит', () => {
  for (const bad of [0, -1, 'abc', null, true, {}, []]) {
    const capabilities = readModelCapabilities({ litellm_params: { max_input_tokens: bad, max_output_tokens: bad } })
    assert.equal(capabilities.contextWindow, undefined, 'max_input_tokens=' + JSON.stringify(bad))
    assert.equal(capabilities.maxTokens, undefined, 'max_output_tokens=' + JSON.stringify(bad))
  }
})

test('строковый "false" не включает картинки', () => {
  // Boolean("false") === true — поэтому сравнение строгое.
  assert.equal(readModelCapabilities({ model_info: { supports_vision: 'false' } }).vision, false)
  assert.equal(readModelCapabilities({ model_info: { supports_vision: 'true' } }).vision, false)
})

test('маршрут объявляет image-вход только при флаге vision', async () => {
  const piAi = {
    createProvider: (spec) => spec,
    lazyApi: (factory) => factory,
    InMemoryCredentialStore: class {},
    defaultAuthContext: {},
  }
  const dshPi = { PiAiAdapter: class {} }
  const dshLlm = { resolveRetryPolicy: () => ({}), LlmError: class extends Error {} }
  const catalog = [
    { id: 'GeneralPurpose', vision: true },
    { id: 'deepseek/deepseek-v4-pro' },
  ]
  const route = buildGatewayRoute({
    piAi,
    loadApi: () => Promise.resolve({}),
    dshPi,
    dshLlm,
    providerId: 'verme-gate',
    displayName: 'Verme',
    baseUrl: 'https://gw.example/v1',
    resolveKey: () => Promise.resolve('sk-test'),
    modelCatalog: () => catalog,
  })
  const models = route.models()
  const vision = models.find((model) => model.id === 'GeneralPurpose')
  const text = models.find((model) => model.id === 'deepseek/deepseek-v4-pro')
  assert.deepEqual(vision.input, ['text', 'image'])
  assert.deepEqual(text.input, ['text'])
})
