/**
 * Клиентская половина автоподключения DSH через SSO verme-gate.
 *
 * Сервер (/connect/start, /connect/poll) выдаёт тот же ключ в окне доставки (повторный poll =
 * защита от потерянного ответа, не второй ключ), поэтому поток и
 * секрет живут только в приватных полях, а ключ — только в аргументе onResult: status() наружу
 * отдаёт состояние, ссылку входа, email и текст ошибки, и никогда — secret или key.
 *
 * Время, сеть и открытие браузера — инъекции (clock/request/openUrl): иначе сценарий «истёк
 * timeoutMs» и «сервер ответил 403» проверялись бы минутами и живой сетью.
 *
 * Побочных эффектов на импорте нет: модуль только объявляет класс и адаптер fetch.
 */

/** Период опроса /connect/poll по умолчанию, мс: человек успевает подтвердить вход в браузере. */
const DEFAULT_POLL_MS = 2000
/** Жёсткий дедлайн одной попытки входа, мс (сервер объявляет expires_in = 900 с). */
const DEFAULT_TIMEOUT_MS = 600000
/** Минимальная длина значения, которое вырезаем из текстов: иначе scrub портит обычные слова. */
const SCRUB_MIN_LENGTH = 4

/** Во сколько раз растягиваем паузу опроса при подряд идущих сетевых ошибках (2 с → 10 с максимум). */
const NETWORK_BACKOFF_LIMIT = 5
/** Сколько раз пробуем применить ключ, если хост ответил временной ошибкой (диск, хранилище ключей). */
const DEFAULT_APPLY_ATTEMPTS = 3
/** Пауза перед повтором применения, мс: растёт линейно (0,5 с, 1 с). */
const DEFAULT_APPLY_RETRY_MS = 500

/**
 * Текст ошибки без стека: в status() и журнал идёт только человеческая причина.
 * @param {unknown} error - пойманное значение.
 * @returns {string} текст ошибки.
 */
function messageOf(error) {
  return String(error && typeof error.message === 'string' ? error.message : error)
}

/** Потолок одного запроса к SSO-серверу, мс: мёртвый шлюз должен стать visible failed, а не висеть. */
const REQUEST_TIMEOUT_MS = 30000

/**
 * Адаптер fetch по умолчанию: всегда {status, json}, тело читается один раз.
 * Запрос ограничен по времени: иначе /connect/start с недоступным шлюзом держал бы маршрут
 * экрана до таймаута сокета, а stop() при выгрузке плагина не освободил бы его быстро.
 * @param {string} url - абсолютный адрес запроса.
 * @param {object} init - параметры fetch (метод, заголовки, тело, signal).
 * @returns {Promise<{status: number, json: object|null}>} код ответа и разобранное тело.
 */
async function fetchRequest(url, init) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  // Внешний signal (stop/dispose) должен побеждать так же, как дедлайн запроса. AbortSignal.any
  // есть не в каждом Node — без него живём только с внешним signal, как раньше.
  const signal = init !== null && init !== undefined && init.signal !== undefined && init.signal !== null
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([init.signal, timeout]) : init.signal)
    : timeout
  const response = await fetch(url, Object.assign({}, init, { signal }))
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, json }
}

/**
 * Коннектор входа через SSO: start() заводит поток и запускает опрос, status() отдаёт снимок.
 *
 * start() намеренно возвращает статус сразу после обмена /connect/start (а не после ready):
 * экран должен показать ссылку входа, пока идёт ожидание. Опрос продолжается в фоне и
 * заканчивается ready (ключ уходит в onResult), failed сервера, 403 или истечением timeoutMs.
 */
export class SsoConnector {
  /** @type {string} */
  #state = 'idle'
  /** @type {string} */
  #loginUrl = ''
  /** @type {string} */
  #email = ''
  /** Код подтверждения со страницы входа: его вводят в браузере, поэтому он и не секрет. @type {string} */
  #userCode = ''
  /** @type {string} */
  #error = ''
  /** Секрет потока: только для тела /connect/poll, наружу не выходит. @type {string} */
  #flow = ''
  /** @type {string} */
  #secret = ''
  /** Идёт ли попытка (обмен /connect/start или опрос). @type {boolean} */
  #active = false
  /** Номер попытки: stop() и повторный start() отменяют все ожидания прежнего номера. @type {number} */
  #generation = 0
  /** @type {ReturnType<typeof setTimeout>|null} */
  #timer = null
  /** @type {(() => void)|null} */
  #wake = null
  /** @type {AbortController|null} */
  #controller = null
  /** Открылся ли браузер на хосте: экран не должен обещать «открыли браузер», если его нет. @type {boolean} */
  #browserOpened = false
  /** Подряд идущие сетевые ошибки опроса: одна не должна убивать попытку. @type {number} */
  #netErrors = 0
  // Поток, который уже погашен через cancel(): уборка при отмене во время старта не должна
  // слать второй cancel по тому же секрету.
  #dropped = ''
  // Номер попытки, ключ которой уже применён: второй готовый ответ (поздняя отмена и опрос
  // приходят одновременно) не должен звать onResult ещё раз.
  #delivered = 0
  // Номер попытки, в которой применение ключа сейчас идёт: защита от параллельного onResult.
  #delivering = 0
  // Шлюз уже выдаёт ключ по подтверждённой заявке: экран должен говорить «выдаётся», а не «ждём».
  #provisioning = false
  /** @type {number} */
  #applyAttempts = DEFAULT_APPLY_ATTEMPTS
  /** @type {number} */
  #applyRetryMs = DEFAULT_APPLY_RETRY_MS

  /**
   * @param {object} options - инъекции.
   * @param {string} options.gateUrl - база SSO-шлюза (без хвостового "/").
   * @param {(url: string, init: object) => Promise<{status: number, json: object|null}>} [options.request] -
   *   транспорт; по умолчанию fetch.
   * @param {(url: string) => Promise<void>} [options.openUrl] - открыть страницу входа в браузере.
   * @param {(result: {key: string, email: string}) => Promise<void>} [options.onResult] - сохранить ключ.
   * @param {(failure: {error: string}) => void} [options.onError] - уведомление о неудаче.
   * @param {number} [options.pollMs] - период опроса, мс.
   * @param {number} [options.timeoutMs] - дедлайн попытки, мс.
   * @param {() => number} [options.clock] - часы, мс.
   * @param {(level: string, message: string) => void} [options.log] - журнал коннектора.
   */
  constructor(options) {
    const settings = options !== null && options !== undefined ? options : {}
    this.gateUrl = String(settings.gateUrl || '').replace(/\/+$/, '')
    this.request = typeof settings.request === 'function' ? settings.request : fetchRequest
    this.openUrl = typeof settings.openUrl === 'function' ? settings.openUrl : async () => {}
    this.onResult = typeof settings.onResult === 'function' ? settings.onResult : async () => {}
    this.onError = typeof settings.onError === 'function' ? settings.onError : () => {}
    this.pollMs = Number.isFinite(settings.pollMs) && settings.pollMs >= 0 ? Number(settings.pollMs) : DEFAULT_POLL_MS
    this.timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0 ? Number(settings.timeoutMs) : DEFAULT_TIMEOUT_MS
    this.clock = typeof settings.clock === 'function' ? settings.clock : Date.now
    this.log = typeof settings.log === 'function' ? settings.log : () => {}
    this.#applyAttempts = Number.isFinite(settings.applyAttempts) && settings.applyAttempts >= 1
      ? Math.floor(Number(settings.applyAttempts)) : DEFAULT_APPLY_ATTEMPTS
    this.#applyRetryMs = Number.isFinite(settings.applyRetryMs) && settings.applyRetryMs >= 0
      ? Number(settings.applyRetryMs) : DEFAULT_APPLY_RETRY_MS
  }

  /**
   * Снимок состояния входа. Ключа здесь нет и быть не может: он уходит только в onResult.
   * @returns {{state: 'idle'|'waiting'|'connected'|'failed', loginUrl: string, email: string, error: string}} статус.
   */
  status() {
    return {
      state: this.#state,
      loginUrl: this.#loginUrl,
      email: this.#email,
      error: this.#error,
      browserOpened: this.#browserOpened,
      userCode: this.#userCode,
      // Ключ уже выдаётся на шлюзе: экран показывает другой текст, чем «ждём подтверждения».
      provisioning: this.#provisioning,
    }
  }

  /**
   * Начать вход: завести поток на сервере, запомнить flow/secret, открыть страницу входа и
   * запустить опрос в фоне. Повторный вызов во время ожидания статус не меняет и второго
   * /connect/start не делает: экран может дёргать кнопку сколько угодно.
   * @returns {Promise<{state: string, loginUrl: string, email: string, error: string}>} статус после обмена.
   */
  async start() {
    if (this.#active) return this.status()
    // Новая попытка отменяет хвосты прошлой: опрос прежнего номера увидит чужую generation и выйдет.
    this.#generation += 1
    const run = this.#generation
    this.#active = true
    this.#state = 'waiting'
    this.#loginUrl = ''
    this.#userCode = ''
    this.#email = ''
    this.#error = ''
    this.#flow = ''
    this.#secret = ''
    this.#browserOpened = false
    this.#netErrors = 0
    this.#provisioning = false
    this.#delivering = 0
    const deadline = this.clock() + this.timeoutMs
    if (this.gateUrl === '') {
      this.#fail(run, 'SSO не настроен: пустой адрес шлюза (ssoUrl)')
      return this.status()
    }
    const controller = new AbortController()
    this.#controller = controller
    let answer
    try {
      answer = await this.request(this.gateUrl + '/connect/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      })
    } catch (error) {
      this.#fail(run, 'шлюз входа недоступен: ' + messageOf(error))
      return this.status()
    }
    const payload = answer !== null && answer !== undefined && answer.json !== null && typeof answer.json === 'object'
      ? answer.json
      : null
    const flow = typeof (payload === null ? undefined : payload.flow) === 'string' ? payload.flow : ''
    const secret = typeof (payload === null ? undefined : payload.secret) === 'string' ? payload.secret : ''
    const loginUrl = typeof (payload === null ? undefined : payload.login_url) === 'string' ? payload.login_url : ''
    if (run !== this.#generation) {
      // Отмена пришла, пока шлюз заводил заявку: человек ссылку уже не увидит, а заявка живёт
      // на шлюзе до конца TTL. Гасим её тем же секретом, а не бросаем слот.
      await this.#dropFlow(flow, secret)
      return this.status()
    }
    if (answer.status !== 200 || payload === null) {
      this.#fail(run, this.#startFailure(answer, payload))
      return this.status()
    }
    if (flow === '' || secret === '' || loginUrl === '') {
      this.#fail(run, 'шлюз входа ответил неполно: нет flow/secret/login_url')
      return this.status()
    }
    // Ссылка уходит в href экрана и в cmd.exe на Windows: только https (http — лишь для локального
    // стенда), только тот же origin, что у шлюза, и никаких управляющих символов.
    const linkProblem = this.#linkProblem(loginUrl)
    if (linkProblem !== '') {
      this.#fail(run, linkProblem)
      return this.status()
    }
    this.#flow = flow
    this.#secret = secret
    this.#loginUrl = loginUrl
    // Код показывается человеку: без него страница входа не подтвердит поток (защита от пересланной ссылки).
    this.#userCode = typeof payload.user_code === 'string' ? payload.user_code : ''
    // Браузер на хосте — best effort: если его нет (сервер без графики, браузер пользователя на
    // другой машине), страница входа всё равно есть в status() и открывается из экрана.
    try {
      await this.openUrl(loginUrl)
      this.#browserOpened = true
    } catch (error) {
      this.log('warn', 'sso: браузер не открылся: ' + this.#scrub(messageOf(error)))
    }
    if (run !== this.#generation) {
      // Отмена пришла, пока шлюз выдавал ссылку: заявка уже есть, а ссылку человек не увидит.
      // Гасим её здесь, иначе она занимает слот и живёт в журнале до конца TTL.
      await this.#dropFlow(flow, secret)
      return this.status()
    }
    // Опрос идёт в фоне: его провал не должен всплывать необработанным отказом и валить процесс DSH.
    this.#poll(run, this.#deadline(payload, deadline), controller).catch((error) => {
      this.#fail(run, 'внутренняя ошибка входа: ' + messageOf(error))
    })
    return this.status()
  }

  /**
   * Проверить ссылку входа перед показом и открытием в браузере хоста.
   *
   * Шлюз — единственная граница доверия, но и его ответ не должен уводить человека на чужой
   * «ADFS»: требуем https (http допустим только для локального стенда), тот же origin, что у
   * шлюза, и отсутствие управляющих символов (перевод строки для cmd.exe — разделитель команд).
   * @param {string} link - login_url из ответа /connect/start.
   * @returns {string} пустая строка, если ссылка годна, иначе человеческая причина.
   */
  #linkProblem(link) {
    const raw = String(link)
    if (/[\u0000-\u001f\u007f]/.test(raw)) return 'шлюз вернул ссылку входа с управляющими символами'
    let parsed
    let gate
    try {
      parsed = new URL(raw)
      gate = new URL(this.gateUrl)
    } catch {
      return 'шлюз вернул ссылку входа, которую нельзя разобрать'
    }
    const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'шлюз вернул небезопасную ссылку входа: ожидался http(s)'
    }
    if (parsed.protocol === 'http:' && !local) {
      return 'шлюз вернул ссылку входа без TLS (http): ожидался https'
    }
    if (parsed.origin !== gate.origin) {
      return 'шлюз вернул ссылку входа на чужой адрес (' + parsed.origin + ')'
    }
    return ''
  }

  /**
   * Дедлайн опроса: не дольше, чем живёт заявка на шлюзе (expires_in).
   * @param {object} payload - ответ /connect/start.
   * @param {number} fallback - дедлайн из timeoutMs.
   * @returns {number} момент истечения по инъектированным часам.
   */
  #deadline(payload, fallback) {
    const expiresIn = Number(payload === null || payload === undefined ? 0 : payload.expires_in)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) return fallback
    return Math.min(fallback, this.clock() + expiresIn * 1000)
  }

  /**
   * Остановить ожидание: снять таймер, прервать запрос, забыть поток и секрет.
   * Состояние connected/failed сохраняется — экран показывает, чем кончилась попытка.
   */
  stop() {
    this.#generation += 1
    // Остановка не должна оставлять «выдаётся» на экране: состояние idle не врёт о прогрессе.
    this.#provisioning = false
    const timer = this.#timer
    const wake = this.#wake
    this.#timer = null
    this.#wake = null
    if (timer !== null) clearTimeout(timer)
    if (wake !== null) wake()
    if (this.#controller !== null) {
      try {
        this.#controller.abort()
      } catch {
        /* прерывать нечего */
      }
      this.#controller = null
    }
    this.#flow = ''
    this.#secret = ''
    // Отмена — это не «попробуйте ссылку ещё раз»: ссылка на брошенный поток только путает.
    this.#loginUrl = ''
    this.#userCode = ''
    if (this.#active) {
      this.#active = false
      if (this.#state === 'waiting') this.#state = 'idle'
    }
  }

  /**
   * Отменить вход по-настоящему: погасить заявку на шлюзе, чтобы брошенная ссылка не выпустила
   * ключ, и только затем снять ожидание. Сбой сети не фатален: локальный stop() всё равно нужен.
   * @returns {Promise<{state: string, loginUrl: string, email: string, error: string, provisioning: boolean}>}
   *   снимок статуса после попытки: экран показывает, что реально произошло (готово/выдаётся/отменено).
   */
  async cancel() {
    const run = this.#generation
    // Ключ уже выдан шлюзом и сохраняется на хосте: отмена не должна выбить поколение из-под
    // сохранения. Иначе onResult доработает, экран останется «ожиданием» и разрешит второй вход.
    if (this.#delivering !== 0 && this.#delivering === run) {
      this.log('info', 'sso: ключ уже выдан и сохраняется, отмена не прерывает сохранение')
      return this.status()
    }
    const flow = this.#flow
    const secret = this.#secret
    const controller = this.#controller
    if (flow === '' || secret === '') {
      this.stop()
      return this.status()
    }
    // Помечаем ДО запроса: уборка при отмене во время старта не должна слать второй cancel.
    this.#dropped = flow + '\n' + secret
    let answer = null
    try {
      answer = await this.request(this.gateUrl + '/connect/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow, secret, cancel: true }),
        signal: controller === null ? undefined : controller.signal,
      })
    } catch (error) {
      this.log('warn', 'sso: заявку не удалось погасить на шлюзе: ' + this.#scrub(messageOf(error)))
    }
    // Пока шёл запрос, человек мог нажать «Войти» заново: эта отмена относится к прошлой попытке
    // и не имеет права погасить новую.
    if (run !== this.#generation) return this.status()
    // Пока шёл запрос, обычный опрос мог получить READY и запустить сохранение ключа (или уже
    // сохранить его). Отмена не имеет права выбить поколение из-под доставки: экран остался бы
    // «ожиданием» при активированном ключе. Проверяем ДО разбора ответа — он уже устарел.
    if ((this.#delivering !== 0 && this.#delivering === run) || this.#delivered === run) {
      this.log('info', 'sso: за время отмены ключ уже выдан, отмена не прерывает доставку')
      return this.status()
    }
    const payload = answer !== null && answer !== undefined && answer.json !== null
      && typeof answer.json === 'object' ? answer.json : null
    if (payload !== null && payload.state === 'provisioning') {
      // Ключ уже выдаётся: отмена его не отзовёт (он появится в LiteLLM), поэтому не врём
      // «отменено», а ждём результат — его заберёт тот же опрос.
      this.#provisioning = true
      this.log('info', 'sso: заявка уже выдаётся, отмена отложена до результата')
      return this.status()
    }
    // Ключ уже выпущен (человек подтвердил в браузере, пока экран ждал): терять живой доступ
    // нельзя. Шлюз отвечает 'ready' без ключа — его отдаст обычный опрос, который идёт дальше.
    if (payload !== null && payload.state === 'ready') {
      this.log('info', 'sso: ключ уже выдан, забираем его опросом вместо отмены')
      return this.status()
    }
    this.stop()
    return this.status()
  }

  /**
   * Человеческий текст отказа /connect/start: плагин ветвится по машинному `code`, а по HTTP-статусу
   * только когда шлюз старый и кода в теле нет.
   * @param {{status: number, json: (object|null)}} answer - ответ шлюза.
   * @param {object|null} payload - разобранное тело ответа.
   * @returns {string} причина для экрана.
   */
  #startFailure(answer, payload) {
    const code = payload !== null && typeof payload.code === 'string' ? payload.code : ''
    const detail = payload !== null && typeof payload.error === 'string' && payload.error !== ''
      ? payload.error
      : 'HTTP ' + String(answer.status)
    if (code === 'misconfigured') {
      // 503 типа misconfigured — шлюз включил автоподключение, но не смог собрать (policy/ключ/
      // каталог): это не «функция выключена», и адресат другой — администратор, а не человек.
      return 'автоподключение на шлюзе настроено с ошибкой: обратитесь к администратору (журнал шлюза)'
    }
    if (code === 'busy') {
      // 503 типа busy — кончились слоты заявок: шлюз жив, повтор через минуту помогает.
      return 'шлюз входа занят: слишком много подключений одновременно, повторите через минуту'
    }
    if (code === 'disabled') {
      return 'автоподключение на шлюзе выключено: обратитесь к администратору'
    }
    // Шлюз без машинного кода (или 429 от самого edge-прокси): статус остаётся единственной зацепкой.
    if (answer.status === 429) return 'слишком много попыток подключения: подождите минуту и начните вход заново'
    if (answer.status === 503) return 'автоподключение на шлюзе настроено с ошибкой: обратитесь к администратору (журнал шлюза)'
    if (answer.status === 404 || answer.status === 405) {
      return 'шлюз не умеет выдавать ключ (HTTP ' + String(answer.status) + '): автоподключение на шлюзе выключено'
    }
    return 'шлюз входа не выдал поток: ' + detail
  }

  /**
   * Погасить заявку, которую плагин уже не покажет (отмена во время старта). Ошибки глушим:
   * это уборка, а не действие человека.
   * @param {string} flow - идентификатор заявки.
   * @param {string} secret - секрет заявки.
   * @returns {Promise<void>}
   */
  async #dropFlow(flow, secret) {
    if (flow === '' || secret === '') return
    if (this.#dropped === flow + '\n' + secret) return
    try {
      await this.request(this.gateUrl + '/connect/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow, secret, cancel: true }),
      })
    } catch (error) {
      this.log('warn', 'sso: брошенную заявку не удалось погасить: ' + this.#scrub(messageOf(error)))
    }
  }

  /**
   * Цикл опроса /connect/poll до ready/failed/403/дедлайна. Ошибки наружу не бросает:
   * любая из них — это failed с человеческим текстом, иначе экран завис бы в «ждём».
   * @param {number} run - номер попытки.
   * @param {number} deadline - момент истечения (по инъектированным часам).
   * @param {AbortController} controller - прерывание запросов при stop().
   */
  async #poll(run, deadline, controller) {
    const flow = this.#flow
    const secret = this.#secret
    for (;;) {
      // Опрос живёт только пока попытка ждёт и не отменена: stop() и failed снимают его сразу.
      if (run !== this.#generation || this.#state !== 'waiting') return
      const left = deadline - this.clock()
      if (left <= 0) {
        // Если перед этим связь уже рвалась — это она и не восстановилась; иначе человек просто
        // не подтвердил вход. Текст должен назвать настоящую причину.
        this.#fail(run, this.#netErrors > 0
          ? 'связь с шлюзом входа потеряна: начните вход заново'
          : 'время ожидания входа истекло: начните вход заново')
        return
      }
      let answer
      try {
        answer = await this.request(this.gateUrl + '/connect/poll', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ flow, secret }),
          signal: controller.signal,
        })
      } catch (error) {
        if (run !== this.#generation) return
        // Обрыв связи (VPN, сон ноутбука) не приговор, пока жив дедлайн: раньше три ошибки подряд
        // (~5 c) закрывали попытку, и реконнект VPN гарантированно её убивал. Теперь только
        // растягиваем интервал, а фатально — лишь истечение дедлайна.
        this.#netErrors += 1
        if (deadline - this.clock() <= 0) {
          this.#fail(run, 'связь с шлюзом входа потеряна: начните вход заново')
          return
        }
        const backoff = Math.min(
          this.pollMs * Math.min(this.#netErrors, NETWORK_BACKOFF_LIMIT),
          Math.max(0, deadline - this.clock()),
        )
        this.log('warn', 'sso: опрос не прошёл (' + String(this.#netErrors) + '): ' + messageOf(error))
        await this.#sleep(backoff)
        continue
      }
      if (run !== this.#generation) return
      this.#netErrors = 0
      const payload = answer !== null && answer !== undefined && answer.json !== null && typeof answer.json === 'object'
        ? answer.json
        : null
      // 403 — шлюз не принял секрет заявки; 404 — заявка истекла или шлюз перезапускался.
      // Повторять бессмысленно, но и тексты должны называть настоящую причину: код в poll не участвует.
      if (answer.status === 403) {
        this.#fail(run, 'шлюз не принял секрет заявки: начните вход заново')
        return
      }
      if (answer.status === 404) {
        this.#fail(run, 'заявка на вход истекла или шлюз перезапускался: начните вход заново')
        return
      }
      // 5xx/408 — это прокси или перезапуск шлюза, а не приговор заявке: она жива до expires_in.
      // Раньше «502 Bad Gateway» от nginx закрывал попытку, хотя человек уже подтвердил вход.
      if (answer.status >= 500 || answer.status === 408) {
        this.#netErrors += 1
        if (deadline - this.clock() <= 0) {
          this.#fail(run, 'связь с шлюзом входа потеряна: начните вход заново')
          return
        }
        const backoff = Math.min(
          this.pollMs * Math.min(this.#netErrors, NETWORK_BACKOFF_LIMIT),
          Math.max(0, deadline - this.clock()),
        )
        this.log('warn', 'sso: шлюз ответил HTTP ' + String(answer.status) + ', повторяем')
        await this.#sleep(backoff)
        continue
      }
      if (answer.status !== 200 || payload === null) {
        const detail = payload !== null && typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : 'HTTP ' + String(answer.status)
        this.#fail(run, 'шлюз не принял проверку входа: ' + detail)
        return
      }
      if (payload.state === 'pending') {
        this.#provisioning = false
        await this.#sleep(Math.min(this.pollMs, Math.max(0, deadline - this.clock())))
        continue
      }
      if (payload.state === 'provisioning') {
        // Шлюз уже выдаёт ключ по подтверждённой заявке: ждём результата, отмена его не отменит.
        this.#provisioning = true
        await this.#sleep(Math.min(this.pollMs, Math.max(0, deadline - this.clock())))
        continue
      }
      if (payload.state === 'ready') {
        const key = typeof payload.key === 'string' ? payload.key.trim() : ''
        const email = typeof payload.email === 'string' ? payload.email : ''
        if (key === '') {
          this.#fail(run, 'сервер сообщил о готовности, но не прислал ключ')
          return
        }
        // Ключ забираем один раз и забываем поток: дальше он живёт только в onResult.
        const spentFlow = this.#flow
        const spentSecret = this.#secret
        this.#flow = ''
        this.#secret = ''
        await this.#deliver(run, key, email, spentFlow, spentSecret)
        return
      }
      if (payload.state === 'failed') {
        const detail = typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : 'вход не выполнен'
        this.#fail(run, detail)
        return
      }
      this.#fail(run, 'сервер прислал неизвестное состояние входа: ' + String(payload.state))
      return
    }
  }

  /**
   * Применить готовый ключ ровно один раз на попытку.
   *
   * Временный сбой хоста (диск, хранилище ключей) повторяем ограниченно: иначе человек видел бы
   * «не удалось» при живом ключе в LiteLLM. Окончательный отказ (ключ не принят шлюзом) не
   * повторяем никогда — и connected объявляем только после успешного применения.
   * @param {number} run - номер попытки.
   * @param {string} key - выданный ключ.
   * @param {string} email - владелец ключа.
   * @param {string} spentFlow - заявка (для очистки текстов).
   * @param {string} spentSecret - секрет заявки (для очистки текстов).
   * @returns {Promise<void>}
   */
  async #deliver(run, key, email, spentFlow, spentSecret) {
    if (run !== this.#generation) return
    if (this.#delivered === run || this.#delivering === run) return
    this.#delivering = run
    // Пока ключ применяется, экран показывает «выдаётся», а кнопка отмены не появляется.
    this.#provisioning = true
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.onResult({ key, email })
        if (run !== this.#generation) return
        this.#delivered = run
        this.#delivering = 0
        this.#state = 'connected'
        this.#email = email
        this.#error = ''
        this.#provisioning = false
        this.#active = false
        this.#controller = null
        this.log('info', 'sso: ключ получен' + (email === '' ? '' : ' для ' + email))
        return
      } catch (error) {
        if (run !== this.#generation) return
        const reason = this.#scrub(messageOf(error), key, spentFlow, spentSecret)
        const retry = this.#applyRetryable(error) && attempt < this.#applyAttempts
        this.log('error', 'sso: ключ не сохранён (попытка ' + String(attempt) + '): ' + reason)
        if (!retry) {
          this.#delivering = 0
          this.#fail(run, 'не удалось применить ключ: ' + reason)
          return
        }
        await this.#sleep(this.#applyRetryMs * attempt)
        if (run !== this.#generation) return
      }
    }
  }

  /**
   * Стоит ли повторять применение ключа: только типизированные временные отказы.
   *
   * Хост помечает retryable=true у сбоев записи (диск, хранилище ключей) и retryable=false у
   * окончательных (ключ не принят). Неразмеченную ошибку считаем окончательной: повторить
   * «неверный ключ» нельзя.
   * @param {unknown} error - отказ onResult.
   * @returns {boolean} true — повтор имеет смысл.
   */
  #applyRetryable(error) {
    if (error === null || error === undefined) return false
    if (error.retryable === true) return true
    if (error.retryable === false) return false
    const code = String(error.code || '')
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code)
  }

  /**
   * Перевести попытку в failed: состояние, текст, уведомление onError, забыть поток и секрет.
   * @param {number} run - номер попытки (устаревшая попытка молчит).
   * @param {string} reason - человеческая причина.
   */
  #fail(run, reason) {
    if (run !== this.#generation) return
    // Текст чистим ДО обнуления секрета: иначе серверный текст с эхом секрета утечёт в status.
    const text = this.#scrub(reason)
    this.#state = 'failed'
    this.#error = text
    this.#active = false
    this.#provisioning = false
    this.#delivering = 0
    // Поток мёртв: оставленная ссылка ведёт на «запрос истёк/уже использован» и только путает.
    this.#loginUrl = ''
    this.#userCode = ''
    this.#flow = ''
    this.#secret = ''
    this.#controller = null
    // Снять паузу между опросами: иначе таймер дожил бы до pollMs уже после failed.
    const timer = this.#timer
    const wake = this.#wake
    this.#timer = null
    this.#wake = null
    if (timer !== null) clearTimeout(timer)
    if (wake !== null) wake()
    this.log('warn', 'sso: ' + text)
    try {
      const answer = this.onError({ error: text })
      // onError может быть async: его провал не должен всплывать необработанным отказом.
      if (answer !== null && answer !== undefined && typeof answer.then === 'function') answer.catch(() => {})
    } catch {
      /* уведомление сломало само себя — состояние уже failed */
    }
  }

  /**
   * Пауза между опросами: таймер запоминается, чтобы stop() снял его сразу, а не ждал pollMs.
   * unref — чтобы ожидание входа не держало процесс живым (актуально для тестов и dispose).
   * @param {number} ms - сколько ждать.
   * @returns {Promise<void>} пауза.
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      this.#wake = resolve
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#wake = null
        resolve()
      }, Math.max(0, ms))
      if (this.#timer !== null && typeof this.#timer.unref === 'function') this.#timer.unref()
    })
  }

  /**
   * Вырезать из текста поток и секрет (и переданный ключ): тексты ошибок уходят в status() и журнал,
   * а туда секреты не попадают никогда.
   * @param {string} text - исходный текст.
   * @param {...string} values - прочие значения, которые тоже нельзя показывать (ключ, старый flow).
   * @returns {string} безопасный текст.
   */
  #scrub(text, ...values) {
    let safe = String(text === undefined || text === null ? '' : text)
    for (const value of [this.#secret, this.#flow, ...values]) {
      if (typeof value === 'string' && value.length >= SCRUB_MIN_LENGTH) safe = safe.split(value).join('***')
    }
    return safe
  }
}
