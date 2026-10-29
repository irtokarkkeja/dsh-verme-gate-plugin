import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import {closure} from './helpers/closure.mjs'

/**
 * Живой HTTP-стенд вместо мока: ответ шлюза идёт через настоящий gatewayGet.
 * @param {object} t - контекст теста (закрывает сервер).
 * @param {number} status - HTTP-код ответа шлюза.
 * @returns {Promise<string>} базовый адрес стенда.
 */
async function stand(t, status) {
  const srv = http.createServer((req, res) => {
    res.writeHead(status, {'content-type': 'application/json'})
    res.end(JSON.stringify({detail: 'refused'}))
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => srv.close(resolve)))
  return 'http://127.0.0.1:' + String(srv.address().port)
}

/**
 * Настоящая цепочка плагина: probeKey -> discoverRegistry -> gatewayGet -> fetch.
 * @param {string} base - адрес стенда.
 * @returns {Function} probeKey.
 */
function realProbe(base) {
  const gatewayGet = closure('gatewayGet', {
    gatewayBase: () => base,
    cfg: {},
    fetch,
    messageOf: (error) => String(error && error.message ? error.message : error),
  })
  const discoverRegistry = closure('discoverRegistry', {gatewayGet, journal: () => {}})
  return closure('probeKey', {
    discoverRegistry,
    discoverModels: async () => ({error: 'models not needed here'}),
  })
}

test('discoverRegistry не теряет HTTP-код шлюза', async () => {
  // Это и был дефект: код ответа отбрасывался, и 401 выглядел как «сеть» (status 0) → retryable.
  const discoverRegistry = closure('discoverRegistry', {
    gatewayGet: async () => ({status: 401, error: 'GET /v1/mcp/server -> HTTP 401'}),
    journal: () => {},
  })
  const answer = await discoverRegistry('sk-revoked')
  assert.equal(answer.status, 401)
  assert.match(answer.error, /HTTP 401/)
})

test('401 от шлюза — окончательный отказ: ключ не повторяют', async (t) => {
  const probe = realProbe(await stand(t, 401))
  const verdict = await probe('sk-revoked')
  assert.match(verdict.error, /шлюз не принял ключ/)
  assert.equal(verdict.retryable, false, '401 не лечится повтором')
})

test('503 от шлюза — временный отказ: применение ключа стоит повторить', async (t) => {
  const probe = realProbe(await stand(t, 503))
  const verdict = await probe('sk-live-abcdef')
  assert.match(verdict.error, /шлюз не принял ключ/)
  assert.equal(verdict.retryable, true, '5xx — это моргание шлюза')
})

test('обрыв сети — временный отказ, а не «ключ неверный»', async () => {
  const probe = realProbe('http://127.0.0.1:1')
  const verdict = await probe('sk-live-abcdef')
  assert.equal(verdict.retryable, true)
})
