/**
 * Маршрут llm, которым плагин владеет сам: провайдер pi-ai с ДИНАМИЧЕСКИМ каталогом моделей.
 *
 * Зачем свой маршрут. Селектор DSH читает каталог у провайдера (llm-pi-ai отдаёт то, что
 * объявлено в cordis.patch.yml), а llm-pi-ai не даёт плагинам регистрировать модели в рантайме.
 * Единственный способ показывать ровно права активного LiteLLM-ключа — владеть маршрутом:
 * `createProvider({ getModels })` + `PiAiAdapter` + `llm.registerAdapter()`. Так же устроены
 * dsh-grok-subscription и dsh-codex-connect (прод :3080).
 *
 * Что здесь происходит. Каждый вызов адаптера пересобирает profile/provider, а `getModels()`
 * читает ТЕКУЩИЙ каталог прав ключа (его обновляет плагин, когда меняется активный токен или
 * приходит ответ GET /v1/models). Поэтому список моделей в GUI живой: ни пересборки бандла, ни
 * рекомпозиции конфига при смене ключа не требуется.
 *
 * Чего здесь нет: собственного HTTP-клиента. Стриминг, ретраи, отмена и нормализация картинок —
 * это pi-ai (`openai-completions`) и `PiAiAdapter` из @deepseek-ai/dsh-llm-pi-ai.
 *
 * @module verme-gate/gateway-route
 */

/** Единственный поддерживаемый протокол: шлюз LiteLLM говорит OpenAI-completions. */
export const GATEWAY_API = 'openai-completions'

/** Умолчания модели: шлюз не сообщает ёмкости, а разрешать «сколько влезет» опасно. */
const DEFAULT_CONTEXT_WINDOW = 131072
const DEFAULT_MAX_TOKENS = 32768

/** Уровень размышлений, который объявляют модели маршрута (как у прод-конфига dshlab). */
// 'off' не null: PiAiAdapter.mapReasoningEffort бросает UNSUPPORTED_REASONING_EFFORT на null-уровне,
// а «выключить размышления» на этом шлюзе нельзя — 'off' отправляет минимальный уровень.
const THINKING_LEVEL_MAP = { off: 'low', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null }

/**
 * Описать одну модель маршрута для pi-ai.
 * @param {string} providerId - id маршрута.
 * @param {string} baseUrl - база шлюза (…/v1).
 * @param {{ id: string, contextWindow?: number, maxTokens?: number }} entry - запись каталога.
 * @param {{ contextWindow: number, maxTokens: number }} fallback - умолчания для моделей без ёмкостей.
 * @returns {object} дескриптор модели pi-ai.
 */
const toPiModel = (providerId, baseUrl, entry, fallback) => ({
  id: entry.id,
  name: entry.id,
  api: GATEWAY_API,
  provider: providerId,
  baseUrl,
  reasoning: true,
  thinkingLevelMap: THINKING_LEVEL_MAP,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Ёмкости из ответа шлюза (он сообщает их не для всех моделей) — иначе дефолт.
  contextWindow: entry.contextWindow ?? fallback.contextWindow,
  maxTokens: entry.maxTokens ?? fallback.maxTokens,
  compat: { supportsLongCacheRetention: false, supportsDeveloperRole: false },
})

/**
 * Собрать адаптер маршрута.
 *
 * @param {object} options - зависимости и данные маршрута.
 * @param {object} options.piAi - модуль @earendil-works/pi-ai (createProvider, lazyApi, InMemoryCredentialStore, defaultAuthContext).
 * @param {() => Promise<object>} options.loadApi - ленивая загрузка модуля протокола (openai-completions).
 * @param {object} options.dshPi - модуль @deepseek-ai/dsh-llm-pi-ai (PiAiAdapter).
 * @param {object} options.dshLlm - модуль @deepseek-ai/dsh-llm (resolveRetryPolicy, LlmError).
 * @param {string} options.providerId - id маршрута (llmProvider из конфига).
 * @param {string} options.displayName - имя в селекторе.
 * @param {string} options.baseUrl - база шлюза (…/v1).
 * @param {() => Promise<string>} options.resolveKey - ключ активного токена ('' — нет ключа).
 * @param {() => { id: string, contextWindow?: number, maxTokens?: number }[]} options.modelCatalog - текущий каталог прав ключа с ёмкостями.
 * @param {() => object | undefined} [options.resolveAttachments] - хранилище вложений хоста.
 * @param {(level: string, message: string) => void} [options.log] - журнал плагина.
 * @returns {{ adapter: object, models: () => object[] }} адаптер и снимок каталога для диагностики.
 */
export function buildGatewayRoute(options) {
  const { piAi, loadApi, dshPi, dshLlm, providerId, displayName, baseUrl, resolveKey, modelCatalog } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  /**
   * Умолчания ёмкостей для моделей, про которые шлюз молчит. Оператор задаёт их в конфиге плагина:
   * порог автокомпакта DSH = min(0.8·окно, окно − объявленный вывод − headroom), поэтому «окно по
   * умолчанию» — это и есть ручка «на каком объёме компактить», когда шлюз ничего не сообщает.
   */
  const fallback = {
    contextWindow: Number(options.defaultContextWindow) || DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number(options.defaultMaxTokens) || DEFAULT_MAX_TOKENS,
  }
  const retryPolicy = dshLlm.resolveRetryPolicy(undefined, providerId)
  const streamApi = piAi.lazyApi(loadApi)

  /** @returns {object[]} дескрипторы моделей текущего каталога. */
  const models = () => (modelCatalog() || []).map((entry) => toPiModel(providerId, baseUrl, entry, fallback))

  /**
   * Провайдер pi-ai. `models` — стартовый пустой список, а `getModels` перекрыт живой функцией:
   * Models.getModels()/getModel() читают её на каждый вызов (pi-ai dist/models.js:55-80), поэтому
   * и селектор, и резолв модели видят свежий каталог без пересоздания коллекции.
   * @returns {object} провайдер pi-ai.
   */
  const buildProvider = () => {
    const provider = piAi.createProvider({
      id: providerId,
      name: displayName,
      baseUrl,
      models: [],
      api: { [GATEWAY_API]: streamApi },
      auth: {
        apiKey: {
          name: displayName + ' — ключ активного токена',
          /**
           * pi-ai спрашивает ключ, когда его нет в переданной credential.
           * @param {{ credential?: { type?: string, key?: string } }} context - контекст запроса ключа.
           * @returns {Promise<object | undefined>} авторизация либо undefined (ключ не настроен).
           */
          resolve: async ({ credential }) => {
            const stored = credential !== undefined && credential !== null && credential.type === 'api_key' ? credential.key : ''
            const key = typeof stored === 'string' && stored !== '' ? stored : await resolveKey()
            if (typeof key !== 'string' || key === '') return undefined
            return { auth: { apiKey: key }, source: displayName }
          },
        },
      },
    })
    return { ...provider, getModels: () => models() }
  }

  /**
   * Разрешённый профиль маршрута в терминах PiAiAdapter. Пересобирается на каждую операцию,
   * поэтому смена ключа/каталога видна следующему же запросу.
   * @returns {object} ResolvedPiAiProviderProfile.
   */
  const buildProfile = () => ({
    provider: providerId,
    displayName,
    api: GATEWAY_API,
    baseURL: baseUrl,
    reasoning: 'low',
    cacheRetention: 'short',
    transport: 'sse',
    defaultContextWindow: fallback.contextWindow,
    defaultMaxTokens: fallback.maxTokens,
    defaultInput: ['text'],
    streamIdleTimeoutMs: 300000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy,
    piProvider: buildProvider(),
    modelErrors: new Map(),
    // PiAiAdapter берёт maxTokens ТОЛЬКО отсюда (modelInfo: profile.configuredMaxTokens);
    // без карты модель объявляется без output-лимита, и шлюзовые max_output_tokens теряются.
    configuredMaxTokens: new Map((modelCatalog() || [])
      .filter((entry) => typeof entry.maxTokens === 'number' && entry.maxTokens > 0)
      .map((entry) => [entry.id, entry.maxTokens])),
  })

  const adapter = new dshPi.PiAiAdapter({
    // Новый Map на каждый вызов: PiAiAdapter кэширует снимок по идентичности карты
    // (…/dsh-llm-pi-ai/lib/index.js, current()), поэтому иначе каталог «залипнет».
    profiles: () => new Map([[providerId, buildProfile()]]),
    /**
     * Ключ на один вызов. PiAiAdapter требует MISSING_CREDENTIAL, когда ключа нет: иначе
     * список моделей молча окажется пустым вместо явной ошибки.
     * @returns {Promise<string>} ключ активного токена.
     */
    resolveApiKey: async () => {
      const key = await resolveKey()
      if (typeof key !== 'string' || key === '') {
        throw new dshLlm.LlmError('verme-gate: у активного токена нет ключа LiteLLM', 'MISSING_CREDENTIAL')
      }
      return key
    },
    auth: {
      credentials: new piAi.InMemoryCredentialStore(),
      // pi-ai спрашивает окружение/файлы только когда ищет свой ambient-ключ; у нас ключ
      // приходит из resolveApiKey, поэтому оба ответа — «нет».
      authContext: Object.freeze({ env: async () => undefined, fileExists: async () => false }),
    },
    ...(typeof options.resolveAttachments === 'function' ? { resolveAttachments: () => options.resolveAttachments() } : {}),
  })

  /**
   * Значения для журнала: сколько моделей видит маршрут и есть ли ключ.
   * @returns {{ route: string, api: string, baseUrl: string, models: number }} срез состояния.
   */
  const describe = () => {
    const count = models().length
    log('debug', 'route ' + providerId + ': ' + count + ' model(s)')
    return { route: providerId, api: GATEWAY_API, baseUrl, models: count }
  }

  return { adapter, models, describe }
}
