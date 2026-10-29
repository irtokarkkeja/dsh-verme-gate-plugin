/**
 * Клиентская половина SSO-автоподключения: поток /connect/start + опрос /connect/poll.
 *
 * Тесты не ходят в сеть и не ждут реального времени: часы и транспорт — инъекции, pollMs = 0,
 * а готовность состояния ловится через waitFor (setImmediate), без собственных таймеров.
 */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {SsoConnector} from '../lib/sso.js'

const GATE = 'https://sso.example/dsh-verme-gate'
const LOGIN_URL = 'https://sso.example/login/flow-1'
const SECRET = 'flow-secret-abcdef'
const KEY = 'sk-live-abcdef'

/**
 * Дождаться состояния коннектора, не заводя своих таймеров: каждый шаг — setImmediate,
 * поэтому 0-мс таймеры самого опроса успевают сработать.
 * @param {() => boolean} predicate - условие готовности.
 * @param {string} what - что ждём (для текста ошибки).
 * @returns {Promise<void>} готовность.
 */
async function waitFor(predicate, what) {
  // Опрос идёт через setTimeout(0), а он в Node клампится в 1 мс: чистый setImmediate-цикл
  // успевает прокрутиться быстрее и ловит ложный таймаут. Поэтому ждём настоящими тиками.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('не дождались: ' + what)
}

/**
 * Коннектор на заглушках: /connect/start всегда выдаёт поток, /connect/poll отдаёт очередь
 * ответов (последний повторяется, чтобы «вечно pending» не заканчивался).
 * @param {{polls?: object[], timeoutMs?: number, clock?: () => number, openThrows?: boolean}} options - сценарий.
 * @returns {object} коннектор и наблюдаемые вызовы.
 */
function harness(options) {
  const settings = options !== null && options !== undefined ? options : {}
  const calls = []
  const logs = []
  const results = []
  const errors = []
  const opened = []
  const polls = Array.isArray(settings.polls) ? settings.polls : [{state: 'pending'}]
  let pollIndex = 0
  const request = async (url, init) => {
    calls.push({url, body: init !== null && init !== undefined ? init.body : ''})
    if (url.endsWith('/connect/start')) {
      if (settings.startAnswer !== undefined) return settings.startAnswer
      return {status: 200, json: {flow: 'flow-' + String(calls.length), secret: SECRET, login_url: LOGIN_URL, expires_in: 900}}
    }
    const answer = polls[Math.min(pollIndex, polls.length - 1)]
    pollIndex += 1
    // Обрыв сети задаётся как {throws: 'текст'}: транспорт бросает, как настоящий fetch.
    if (answer !== null && typeof answer === 'object' && typeof answer.throws === 'string') {
      throw new Error(answer.throws)
    }
    // Полный ответ ({status, json}) можно задать целиком — так проверяются 403 и HTTP-ошибки.
    return answer !== null && typeof answer === 'object' && typeof answer.status === 'number'
      ? answer
      : {status: 200, json: answer}
  }
  const connector = new SsoConnector({
    gateUrl: GATE,
    request,
    openUrl: async (url) => {
      opened.push(url)
      if (settings.openThrows === true) throw new Error('нет браузера')
      // Крючок для гонок: «человек нажал Отменить, пока шлюз выдавал ссылку».
      if (typeof settings.afterOpen === 'function') await settings.afterOpen()
    },
    onResult: async (result) => {
      if (settings.onResultThrows === true) throw new Error('не удалось применить ключ: ' + result.key + ' секрет ' + SECRET)
      results.push(result)
    },
    onError: (failure) => { errors.push(failure.error) },
    pollMs: 0,
    timeoutMs: settings.timeoutMs !== undefined ? settings.timeoutMs : 60000,
    clock: typeof settings.clock === 'function' ? settings.clock : () => 0,
    log: (level, message) => { logs.push(level + ': ' + message) },
  })
  return {
    connector,
    calls,
    logs,
    results,
    errors,
    opened,
    pollCalls: () => calls.filter((call) => call.url.endsWith('/connect/poll')),
    startCalls: () => calls.filter((call) => call.url.endsWith('/connect/start')),
  }
}

test('pending → ready: onResult вызван один раз с ключом, состояние connected', async () => {
  const s = harness({polls: [{state: 'pending'}, {state: 'pending'}, {state: 'ready', email: 'user@example.com', key: KEY}]})
  const started = await s.connector.start()
  assert.equal(started.state, 'waiting')
  assert.equal(started.loginUrl, LOGIN_URL)
  assert.deepEqual(s.opened, [LOGIN_URL])
  assert.deepEqual(JSON.parse(s.pollCalls()[0].body), {flow: 'flow-1', secret: SECRET})
  await waitFor(() => s.connector.status().state === 'connected', 'connected')
  assert.equal(s.results.length, 1)
  assert.deepEqual(s.results[0], {key: KEY, email: 'user@example.com'})
  assert.equal(s.connector.status().email, 'user@example.com')
  assert.equal(s.connector.status().error, '')
  assert.equal(s.startCalls().length, 1)
})

test('ошибка открытия браузера не фатальна: login_url остаётся в статусе', async () => {
  const s = harness({polls: [{state: 'ready', email: 'user@example.com', key: KEY}], openThrows: true})
  const started = await s.connector.start()
  assert.equal(started.state, 'waiting')
  assert.equal(started.loginUrl, LOGIN_URL)
  assert.match(s.logs.join(' '), /браузер не открылся/)
  await waitFor(() => s.connector.status().state === 'connected', 'connected')
  assert.equal(s.results.length, 1)
})

test('failed от сервера: состояние failed, ключ не применяется, повторный старт разрешён', async () => {
  // Вторая попытка получает pending: после ошибки старт разрешён и начинает новый поток.
  const s = harness({polls: [{state: 'failed', error: 'нет доступа к verme-gate'}, {state: 'pending'}]})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed')
  assert.equal(s.results.length, 0)
  assert.equal(s.connector.status().error, 'нет доступа к verme-gate')
  assert.deepEqual(s.errors, ['нет доступа к verme-gate'])
  await s.connector.start()
  assert.equal(s.connector.status().state, 'waiting')
  assert.equal(s.startCalls().length, 2)
  s.connector.stop()
})

test('403 на poll: состояние failed, без повторов', async () => {
  const s = harness({polls: [{status: 403, json: {}}]})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed')
  assert.equal(s.results.length, 0)
  assert.match(s.connector.status().error, /не принял секрет заявки/)
  assert.equal(s.pollCalls().length, 1)
})

test('таймаут: failed по инъектированным часам, опрос останавливается, stop() не оставляет таймеров', async () => {
  let now = 0
  const s = harness({
    polls: [{state: 'pending'}],
    timeoutMs: 2500,
    clock: () => { now += 700; return now },
  })
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'timeout')
  assert.match(s.connector.status().error, /истекло/)
  assert.equal(s.results.length, 0)
  const settled = s.pollCalls().length
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(s.pollCalls().length, settled)
  assert.doesNotThrow(() => s.connector.stop())
  assert.equal(s.connector.status().state, 'failed')
})

test('повторный start() во время ожидания не делает второй /connect/start', async () => {
  const s = harness({polls: [{state: 'pending'}]})
  const first = await s.connector.start()
  const second = await s.connector.start()
  assert.equal(s.startCalls().length, 1)
  assert.deepEqual(second, first)
  assert.equal(second.state, 'waiting')
  s.connector.stop()
  assert.equal(s.connector.status().state, 'idle')
  await s.connector.start()
  assert.equal(s.startCalls().length, 2)
  s.connector.stop()
})

test('в JSON.stringify(status()) нет ни ключа, ни секрета потока; журнал тоже чист', async () => {
  const s = harness({polls: [{state: 'pending'}, {state: 'ready', email: 'user@example.com', key: KEY}]})
  await s.connector.start()
  const waiting = JSON.stringify(s.connector.status())
  assert.ok(!waiting.includes(SECRET))
  assert.ok(!waiting.includes('sk-'))
  await waitFor(() => s.connector.status().state === 'connected', 'connected')
  const connected = JSON.stringify(s.connector.status())
  assert.ok(!connected.includes(KEY))
  assert.ok(!connected.includes(SECRET))
  assert.ok(!connected.includes('sk-'))
  const journal = s.logs.join(' ')
  assert.ok(!journal.includes(SECRET))
  assert.ok(!journal.includes(KEY))
  // Секрет запроса живёт только в теле /connect/poll — это контракт сервера, не утечка наружу.
  assert.ok(s.pollCalls().every((call) => JSON.parse(call.body).secret === SECRET))
})
test('404 от /connect/start: текст про выключенное автоподключение, а не «HTTP 404»', async () => {
  const s = harness({startAnswer: {status: 404, json: null}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /не умеет выдавать ключ/)
  assert.match(started.error, /404/)
})

test('429 от /connect/start — текст про лимит попыток, а не «HTTP 429»', async () => {
  const s = harness({startAnswer: {status: 429, json: {error: 'слишком много попыток подключения, подождите минуту'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /подождите минуту/)
  assert.doesNotMatch(started.error, /HTTP 429/)
})

test('код подтверждения попадает в статус и не мешает остальным полям', async () => {
  const s = harness({startAnswer: {status: 200, json: {flow: 'f-1', secret: SECRET, login_url: LOGIN_URL, user_code: 'ABCD-EFGH'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'waiting')
  assert.equal(started.userCode, 'ABCD-EFGH')
  s.connector.stop()
  assert.equal(s.connector.status().userCode, '')
})

test('небезопасная ссылка входа (javascript:) отклоняется', async () => {
  const s = harness({startAnswer: {status: 200, json: {flow: 'flow-x', secret: SECRET, login_url: 'javascript:alert(1)'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /небезопасную ссылку/)
  assert.equal(started.loginUrl, '')
  assert.deepEqual(s.opened, [])
})

test('failed очищает ссылку входа: мёртвый поток не предлагается открыть', async () => {
  const s = harness({polls: [{status: 403, json: null}]})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed после 403')
  assert.equal(s.connector.status().loginUrl, '')
})

test('onResult бросает: ни ключ, ни секрет потока не попадают в status().error', async () => {
  const s = harness({polls: [{state: 'ready', email: 'user@example.com', key: KEY}], onResultThrows: true})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed после ошибки применения')
  const error = s.connector.status().error
  assert.doesNotMatch(error, new RegExp(KEY))
  assert.doesNotMatch(error, new RegExp(SECRET))
  assert.match(error, /\*\*\*/)
})

test('две сетевые ошибки подряд не закрывают попытку: опрос продолжается', async () => {
  const s = harness({polls: [{throws: 'обрыв'}, {throws: 'обрыв'}, {state: 'pending'}, {state: 'ready', email: 'u@e', key: KEY}]})
  const started = await s.connector.start()
  assert.equal(started.state, 'waiting')
  await waitFor(() => s.connector.status().state === 'connected', 'connected после восстановления сети')
  assert.deepEqual(s.results, [{key: KEY, email: 'u@e'}])
})

test('долгая потеря сети терпится, пока жив дедлайн: обрыв VPN не убивает попытку', async () => {
  const s = harness({polls: [
    {throws: 'обрыв'}, {throws: 'обрыв'}, {throws: 'обрыв'}, {throws: 'обрыв'},
    {throws: 'обрыв'}, {throws: 'обрыв'}, {throws: 'обрыв'}, {throws: 'обрыв'},
    {state: 'pending'},
    {state: 'ready', email: 'u@e', key: KEY},
  ]})
  const started = await s.connector.start()
  assert.equal(started.state, 'waiting')
  await waitFor(() => s.connector.status().state === 'connected', 'connected после возврата сети')
  assert.deepEqual(s.results, [{key: KEY, email: 'u@e'}])
})

test('сеть не вернулась до дедлайна — failed с текстом про потерю связи', async () => {
  let now = 0
  const s = harness({
    polls: [{throws: 'обрыв'}],
    timeoutMs: 50,
    clock: () => {
      now += 10
      return now
    },
  })
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed по дедлайну')
  assert.match(s.connector.status().error, /связь с шлюзом входа потеряна/)
})

test('чужой origin в ссылке входа отклоняется: ключ не уходит на подставной ADFS', async () => {
  const s = harness({startAnswer: {status: 200, json: {flow: 'f-1', secret: SECRET, login_url: 'https://evil.example/login'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /на чужой адрес/)
  assert.deepEqual(s.opened, [])
})

test('503 от /connect/start — «настроено с ошибкой», а не «выключено»', async () => {
  const s = harness({startAnswer: {status: 503, json: {error: 'автоподключение настроено с ошибкой'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /настроено с ошибкой/)
  assert.doesNotMatch(started.error, /выключено/)
})

test('503 busy от /connect/start — «занят, повторите», а не «сломано»', async () => {
  // Один и тот же статус 503 значит две разные вещи: сломанную настройку и кончившиеся слоты.
  // Плагин обязан ветвиться по машинному коду, иначе человек идёт к администратору зря.
  const s = harness({startAnswer: {status: 503, json: {error: 'шлюз занят', code: 'busy'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /занят/)
  assert.match(started.error, /повторите/)
  assert.doesNotMatch(started.error, /администратору/)
})


test('404 с кодом disabled — «выключено», без догадок по статусу', async () => {
  const s = harness({startAnswer: {status: 404, json: {error: 'выключено', code: 'disabled'}}})
  const started = await s.connector.start()
  assert.equal(started.state, 'failed')
  assert.match(started.error, /выключено/)
})

test('502 от прокси во время опроса не закрывает попытку: заявка жива до expires_in', async () => {
  // Раньше «502 Bad Gateway» от nginx на /connect/poll превращался в failed, хотя человек
  // уже подтвердил вход и ключ ждал его в шлюзе.
  const s = harness({polls: [{status: 502, json: null}, {status: 503, json: null}, {state: 'ready', email: 'u@e', key: KEY}]})
  const started = await s.connector.start()
  assert.equal(started.state, 'waiting')
  await waitFor(() => s.connector.status().state === 'connected', 'connected после 502')
  assert.deepEqual(s.results, [{key: KEY, email: 'u@e'}])
})

test('cancel() гасит заявку на шлюзе и очищает экран', async () => {
  const s = harness({polls: [{state: 'pending'}]})
  await s.connector.start()
  await s.connector.cancel()
  const cancelCall = s.pollCalls().find((call) => String(call.body).includes('"cancel":true'))
  assert.ok(cancelCall, 'нет запроса с cancel:true')
  assert.deepEqual(JSON.parse(cancelCall.body), {flow: 'flow-1', secret: SECRET, cancel: true})
  const state = s.connector.status()
  assert.equal(state.state, 'idle')
  assert.equal(state.loginUrl, '')
  assert.equal(state.userCode, '')
})

test('отмена во время старта гасит уже созданную заявку: слот не висит 15 минут', async () => {
  // Ссылку человек так и не увидел, но поток на шлюзе уже создан: уборка обязана быть.
  let s
  const settings = {
    polls: [{state: 'pending'}],
    afterOpen: async () => { await s.connector.cancel() },
  }
  s = harness(settings)
  const started = await s.connector.start()
  assert.equal(started.state, 'idle')
  const cancels = s.pollCalls().filter((call) => String(call.body).includes('"cancel":true'))
  assert.equal(cancels.length, 1)
  assert.deepEqual(JSON.parse(cancels[0].body), {flow: 'flow-1', secret: SECRET, cancel: true})
})

test('дедлайн берётся из expires_in, если он короче timeoutMs', async () => {
  let now = 0
  const s = harness({
    startAnswer: {status: 200, json: {flow: 'f-1', secret: SECRET, login_url: LOGIN_URL, expires_in: 5}},
    polls: [{state: 'pending'}],
    timeoutMs: 600000,
    clock: () => {
      now += 1000
      return now
    },
  })
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed по expires_in')
  assert.match(s.connector.status().error, /время ожидания входа истекло/)
})

test('ready без ключа — failed, onResult не вызывается', async () => {
  const s = harness({polls: [{state: 'ready', email: 'u@e'}]})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed без ключа')
  assert.match(s.connector.status().error, /не прислал ключ/)
  assert.deepEqual(s.results, [])
})

test('200 без JSON — failed, а не вечное ожидание', async () => {
  const s = harness({polls: [{status: 200, json: null}]})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed на пустом ответе')
  assert.match(s.connector.status().error, /не принял проверку входа/)
})

test('повторный start() после connected заводит новый поток (лечит тупик «только Готово»)', async () => {
  const s = harness({polls: [{state: 'ready', email: 'u@e', key: KEY}, {state: 'pending'}]})
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'connected', 'connected')
  const again = await s.connector.start()
  assert.equal(again.state, 'waiting')
  assert.equal(s.startCalls().length, 2)
})

test('browserOpened отражает факт открытия браузера', async () => {
  const ok = harness({})
  const started = await ok.connector.start()
  assert.equal(started.browserOpened, true)
  const broken = harness({openThrows: true})
  const failedOpen = await broken.connector.start()
  assert.equal(failedOpen.browserOpened, false)
  assert.equal(failedOpen.state, 'waiting')
})

test('stop() во время опроса отменяет попытку и не оставляет таймеров', async () => {
  const s = harness({polls: [{state: 'pending'}]})
  await s.connector.start()
  await waitFor(() => s.pollCalls().length > 0, 'первый опрос')
  s.connector.stop()
  assert.equal(s.connector.status().state, 'idle')
  assert.equal(s.connector.status().loginUrl, '')
})

test('cancel() после выдачи ключа не выбрасывает его: экран получает ключ, а не «отменено»', async () => {
  // Человек подтвердил вход в браузере, а на экране ещё «ждём»: отмена не должна оставить ключ
  // сиротой в LiteLLM. Шлюз отвечает на cancel состоянием ready без ключа — ключ заберёт обычный
  // опрос, и подключение завершится успехом, а не «отменено».
  const results = []
  let canceled = false
  const connector = new SsoConnector({
    gateUrl: GATE,
    request: async (url, init) => {
      if (url.endsWith('/connect/start')) {
        return {status: 200, json: {flow: 'flow-1', secret: SECRET, login_url: LOGIN_URL, expires_in: 900}}
      }
      const body = JSON.parse(String(init.body))
      if (body.cancel === true) {
        canceled = true
        return {status: 200, json: {state: 'ready'}}
      }
      // Опрос либо ещё ждёт, либо (после отмены) забирает выпущенный ключ.
      return {status: 200, json: canceled ? {state: 'ready', key: KEY, email: 'u@e'} : {state: 'pending'}}
    },
    openUrl: async () => {},
    onResult: async (result) => { results.push(result) },
    pollMs: 0,
    timeoutMs: 60000,
    clock: () => 0,
    log: () => {},
  })
  await connector.start()
  await connector.cancel()
  await waitFor(() => connector.status().state === 'connected', 'connected после поздней отмены')
  assert.deepEqual(results, [{key: KEY, email: 'u@e'}])
  assert.equal(connector.status().provisioning, false)
})
/* ─────────── отмена, одно поколение и ограниченный retry применения ─────────── */

/**
 * Коннектор с ручным транспортом: тест сам решает, когда ответить на каждый запрос.
 * @param {object} settings - onResult/onError и начальные ответы.
 * @returns {object} коннектор, счётчики и хуки.
 */
function manual(settings) {
  const state = {
    results: [],
    errors: [],
    polls: [],
    cancels: [],
    applies: 0,
    starts: 0,
    flow: '',
    holdApply: false,
    releaseApply: null,
    cancelAnswer: {state: 'failed', error: 'вход отменён в DSH, начните заново'},
    pollAnswer: {state: 'pending'},
    holdPolls: false,
    releasePolls: null,
    holdStart: false,
    releaseStart: null,
    cancelThrows: false,
    cancelStatus: 200,
    holdCancel: false,
    releaseCancel: null,
  }
  const request = async (url, init) => {
    const body = JSON.parse(init !== null && init !== undefined && init.body ? init.body : '{}')
    if (url.endsWith('/connect/start')) {
      state.starts += 1
      if (state.holdStart) await new Promise((resolve) => { state.releaseStart = resolve })
      state.flow = 'flow-' + String(state.polls.length + 1)
      return {status: 200, json: {flow: state.flow, secret: SECRET, login_url: LOGIN_URL, expires_in: 900}}
    }
    if (body.cancel === true) {
      state.cancels.push(body)
      if (state.holdCancel) await new Promise((resolve) => { state.releaseCancel = resolve })
      if (state.cancelThrows) throw new Error('сеть отмены недоступна')
      return {status: state.cancelStatus, json: state.cancelAnswer}
    }
    state.polls.push(body)
    if (state.holdPolls) await new Promise((resolve) => { state.releasePolls = resolve })
    return {status: 200, json: state.pollAnswer}
  }
  const connector = new SsoConnector({
    gateUrl: GATE,
    request,
    openUrl: async () => {},
    onResult: async (result) => {
      state.applies += 1
      if (state.holdApply) await new Promise((resolve) => { state.releaseApply = resolve })
      if (typeof settings.onApply === 'function') {
        const outcome = settings.onApply(state.applies, result)
        if (outcome instanceof Error) throw outcome
      }
      state.results.push(result)
    },
    onError: (failure) => { state.errors.push(failure.error) },
    pollMs: 0,
    applyRetryMs: 0,
    timeoutMs: 60000,
    clock: () => 0,
    log: () => {},
  })
  return {connector, state}
}

test('поздняя отмена: готовый ключ добирается обычным poll, onResult ровно один раз', async () => {
  const s = manual({})
  s.state.holdPolls = true
  await s.connector.start()
  await waitFor(() => s.state.polls.length === 1, 'первый poll')
  // Шлюз отвечает на отмену «ready» без ключа: ключ лежит в заявке и ждёт обычного poll.
  s.state.cancelAnswer = {state: 'ready'}
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  const cancelled = s.connector.cancel()
  s.state.releasePolls()
  await cancelled
  await waitFor(() => s.connector.status().state === 'connected', 'connected после поздней отмены')
  assert.equal(s.state.results.length, 1)
  assert.deepEqual(s.state.results[0], {key: KEY, email: 'user@example.com'})
  assert.equal(s.connector.status().error, '')
})

test('отмена во время выдачи не обещает отсутствия доступа: ждём результат заявки', async () => {
  const s = manual({})
  await s.connector.start()
  await waitFor(() => s.state.polls.length >= 1, 'первый poll')
  s.state.cancelAnswer = {state: 'provisioning'}
  await s.connector.cancel()
  // Отмена не сняла ожидание и не объявила отказ: ключ ещё выдаётся этим же потоком.
  assert.equal(s.connector.status().state, 'waiting')
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await waitFor(() => s.connector.status().state === 'connected', 'connected после выдачи')
  assert.equal(s.state.results.length, 1)
})

test('старая отмена не останавливает новый вход', async () => {
  const s = manual({})
  s.state.holdCancel = true
  await s.connector.start()
  await waitFor(() => s.state.polls.length >= 1, 'первый poll')
  const staleCancel = s.connector.cancel()
  await waitFor(() => typeof s.state.releaseCancel === 'function', 'запрос отмены ушёл')
  // Пока отмена висела в сети, старая попытка сама закончилась отказом.
  s.state.pollAnswer = {state: 'failed', error: 'время ожидания входа истекло'}
  await waitFor(() => s.connector.status().state === 'failed', 'старая попытка закрылась')
  // Человек начал новый вход: ответ старой отмены не должен его погасить.
  s.state.pollAnswer = {state: 'pending'}
  await s.connector.start()
  s.state.releaseCancel()
  await staleCancel
  assert.equal(s.connector.status().state, 'waiting')
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await waitFor(() => s.connector.status().state === 'connected', 'connected нового входа')
  assert.equal(s.state.results.length, 1)
})

test('отмена во время /connect/start гасит уже созданную заявку, а не занимает слот', async () => {
  const s = manual({})
  s.state.holdStart = true
  const starting = s.connector.start()
  await waitFor(() => s.state.starts === 1, 'запрос старта ушёл')
  // До ответа /connect/start у коннектора ещё нет flow: отмена снимает ожидание сразу.
  await s.connector.cancel()
  s.state.releaseStart()
  await starting
  await waitFor(() => s.state.cancels.length === 1, 'созданная заявка погашена')
  assert.equal(s.state.cancels[0].flow, 'flow-1')
  assert.equal(s.connector.status().state, 'idle')
})

test('отмена во время сохранения ключа не прерывает выдачу и не пускает второй вход', async () => {
  const s = manual({})
  s.state.holdApply = true
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await s.connector.start()
  await waitFor(() => s.state.applies === 1, 'ключ начал сохраняться')
  assert.equal(s.connector.status().provisioning, true, 'экран должен показывать выдачу, а не просто ожидание')
  await s.connector.cancel()
  assert.equal(s.state.cancels.length, 0, 'после выдачи ключа отмена не гасит заявку')
  assert.equal(s.connector.status().state, 'waiting', 'отмена не подменила состояние сохранения')
  s.state.releaseApply()
  await waitFor(() => s.connector.status().state === 'connected', 'connected после сохранения')
  assert.equal(s.state.results.length, 1)
})

/**
 * Отмена уходит в сеть, и только пока она летит, обычный опрос получает READY и запускает сохранение.
 * @param {import('node:test').TestContext} t - контекст теста.
 * @param {{cancelThrows?: boolean, cancelStatus?: number}} failure - чем кончается запрос отмены.
 * @returns {Promise<void>}
 */
async function lateRace(t, failure) {
  const s = manual({})
  s.state.holdApply = true
  s.state.holdPolls = true
  s.state.holdCancel = true
  Object.assign(s.state, failure)
  await s.connector.start()
  await waitFor(() => s.state.polls.length === 1, 'первый poll')
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  const cancelling = s.connector.cancel()
  await waitFor(() => typeof s.state.releaseCancel === 'function', 'запрос отмены ушёл')
  // Пока отмена в сети, опрос получает READY: ключ уже сохранён шлюзом, применение началось.
  s.state.releasePolls()
  await waitFor(() => s.state.applies === 1, 'ключ сохраняется')
  assert.equal(s.connector.status().provisioning, true)
  s.state.releaseCancel()
  await cancelling
  assert.equal(s.connector.status().state, 'waiting', 'отмена не должна выбить поколение из-под сохранения')
  s.state.releaseApply()
  await waitFor(() => s.connector.status().state === 'connected', 'connected после сохранения')
  assert.equal(s.state.results.length, 1)
}

test('отмена с обрывом сети во время обычного опроса не гасит уже начатое сохранение', async (t) => {
  await lateRace(t, {cancelThrows: true})
})

test('отмена с 5xx во время обычного опроса не гасит уже начатое сохранение', async (t) => {
  await lateRace(t, {cancelStatus: 503})
})

test('пока ключ сохраняется, второй start() не заводит новую заявку', async () => {
  const s = manual({})
  s.state.holdApply = true
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await s.connector.start()
  await waitFor(() => s.state.applies === 1, 'ключ начал сохраняться')
  await s.connector.start()
  assert.equal(s.state.starts, 1, 'второй вход не должен обгонять сохранение ключа')
  s.state.releaseApply()
  await waitFor(() => s.connector.status().state === 'connected', 'connected')
  assert.equal(s.state.results.length, 1)
})

test('явный stop() во время сохранения снимает ожидание, но не оставляет флаг выдачи', async () => {
  const s = manual({})
  s.state.holdApply = true
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await s.connector.start()
  await waitFor(() => s.state.applies === 1, 'ключ начал сохраняться')
  s.connector.stop()
  assert.equal(s.connector.status().state, 'idle')
  assert.equal(s.connector.status().provisioning, false, 'idle не должен нести флаг выдачи')
  s.state.releaseApply()
})

test('временный сбой применения ключа повторяется ограниченно и заканчивается успехом', async () => {
  const s = manual({onApply: (attempt) => (attempt <= 2 ? Object.assign(new Error('занято'), {retryable: true}) : undefined)})
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'connected', 'connected после повторов')
  assert.equal(s.state.applies, 3)
  assert.equal(s.state.results.length, 1)
  assert.deepEqual(s.state.errors, [])
})

test('окончательный сбой применения ключа не выдаёт connected и не повторяется', async () => {
  const s = manual({onApply: () => Object.assign(new Error('ключ не принят шлюзом'), {retryable: false})})
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed')
  assert.equal(s.state.applies, 1)
  assert.equal(s.state.results.length, 0)
  assert.match(s.connector.status().error, /ключ/)
})

test('исчерпанные повторы применения дают понятный failed, а не connected', async () => {
  const s = manual({onApply: () => Object.assign(new Error('диск недоступен'), {retryable: true})})
  s.state.pollAnswer = {state: 'ready', email: 'user@example.com', key: KEY}
  await s.connector.start()
  await waitFor(() => s.connector.status().state === 'failed', 'failed')
  assert.equal(s.state.applies, 3)
  assert.equal(s.state.results.length, 0)
  assert.equal(s.state.errors.length, 1)
})
