/**
 * dsh-mcp-access — «токен доступа = профиль» для DSH 0.2.1-rc.2 (host-only плагин).
 *
 * Скоуп (решение владельца): плагин обслуживает ТОЛЬКО MCP, проксируемые шлюзом LiteLLM
 * (https://ai-labs-litellm.verme.ru/<server_name>/mcp). Локальные stdio-серверы — вне плагина.
 *
 * По активному токену доступа плагин:
 *   1) M1 — спрашивает у шлюза реестр серверов, доступных ключу (GET /v1/mcp/server КЛЮЧОМ ТОКЕНА:
 *      шлюз отдаёт только разрешённые ключу серверы, master-key не нужен), монтирует их строками
 *      @deepseek-ai/dsh-mcp-client (transport streamable-http, url <gateway>/<server>/mcp,
 *      заголовок Authorization: Bearer <ключ активного токена>) и подмешивает личный серверный токен
 *      для header-режима; для gateway-режима показывает статус env-переменных и ссылку setup_url;
 *   2) M2 — прячет у агентов MCP-тулзы вне allowlist (ctx.tools.restrict в scope агента);
 *   3) M3 — держит модели в соответствии с правами токена: LiteLLM-ключ активного токена пишется в
 *      СВОЙ credential-ref плагина (MCP_ACCESS_*), каталог сужается до GET /v1/models этим ключом,
 *      модель вне нового списка заменяется доступной;
 *   4) M4 — host-страница /mcp-access: токены и их ключи, write-only поля серверных токенов,
 *      статусы is_set / missing_count, ссылки setup_url, переключение активного токена живьём.
 *
 * Версия 0.2.0 — фиксы по ревью docs/reviews/dsh-mcp-access-review.md (4×P1 + P2):
 *   P1-1/F1  все ручки закрыты тем же периметром, что и /api DSH: ctx.connection.requestRejection(req)
 *            (Host/Origin-фенс + браузерная аутентификация; тот же шов, что у web-no-token и
 *            dsh-host-open-in-app/lib/index.js:1263-1270) + Content-Type: application/json и POST для
 *            мутаций — см. rejected()/readJsonBody()/register();
 *   P1-2/F2  плагин пишет credential-ref ТОЛЬКО своего пространства имён (MCP_ACCESS_*), снимает снимок
 *            прежнего значения и восстанавливает его на dispose; чужой ref = ошибка конфига, ключ не
 *            трогается — см. snapshotCredential()/restoreCredentialSnapshots()/isOwnRef();
 *   P1-3/F4  двухфазное применение: (a) барьер deny-all на всех агентов + снятие монтирований,
 *            (b) новые гранты/монтирования/модель, (c) финальный гейт по новому allowlist; гранты и
 *            managedNames публикуются одним синхронным коммитом — окна fail-open нет;
 *   P1-4/F5  все применения сериализованы очередью (serialise()), tmp-имя состояния уникально
 *            (pid+randomUUID) с retry rename; generation растёт только после успешного применения;
 *   P2     пересчёт гейтов вместо инкрементальных запретов (залипшие запреты), фолбэк каталога при
 *            пустом пересечении token.models ∩ keyModels, отказ монтировать при битом ключе,
 *            агрегированный и ротируемый журнал, валидация pagePath/stateFile/logFile/llmSecretRef/
 *            tokenHeader, дедупликация server_name из реестра, отказ от хрупкого fiber.state.
 *
 * Контракты установки (PKG = /home/seva/dsh-prod021-pkg/node_modules/@deepseek-ai):
 *   - ctx.plugin(McpClient, cfg): прецедент PKG/dsh-acp/lib/index.js:12,216-219;
 *   - Config mcp-client (transport/serverName/url/headers/reconnect): PKG/dsh-mcp-client/lib/index.js:780-800;
 *     имена тулзов mcp__<server>__<raw>: PKG/dsh-mcp-client/lib/index.js:85-100;
 *   - ctx.tools.restrict(filter) — ТОЛЬКО из scoped ctx (из root бросает): PKG/dsh-tools/lib/index.js:2991-3005;
 *   - каталог моделей собирается на каждый RPC из ctx.llm.listProviders/listModels:
 *     PKG/dsh-api-session-controller/lib/index.js:563-608;
 *   - credentials resolve/describe/set/unset + credentialRef: PKG/dsh-credentials/README.md:54-61;
 *   - ctx.webServer.register({kind,path,handler}): PKG/dsh-host-webserver/lib/types/index.d.ts:31-42;
 *   - ctx.connection.requestRejection(req): PKG/dsh-client-connection/lib/types/rpc.d.ts:185,
 *     реализация PKG/dsh-client-connection/lib/index.js:737-750 (admit -> isTrustedApiRequest :240-250);
 *   - agent/created, Agent.ctx: PKG/dsh-agent/lib/types/runtime-types.d.ts:227,149.
 *
 * Секреты: значения только в credential-store ($DSH_HOME/.credentials.yaml); в конфиг, лог и
 * API-ответы попадает только факт configured (boolean) и длина, никогда значение.
 */

import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile, rename, stat, appendFile, chmod } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

const LOG_PREFIX = '[dsh-mcp-access]'
/** POSIX-identifier credential-ref (копия REF_PATTERN, PKG/dsh-credentials/lib/index.js:13). */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Пространство имён credential-ref'ов плагина: чужие ref'ы писать запрещено (ревью P1-2/F2). */
const OWN_REF_PREFIX = 'MCP_ACCESS_'
/** Контракт имени функции DeepSeek (PKG/dsh-mcp-client/lib/index.js:63-71). */
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
/** serverName mcp-client: ^[A-Za-z0-9_-]{1,32}$ (PKG/dsh-mcp-client/lib/index.js:767,782). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** Страница плагина: один-два сегмента пути, без '/' и без конфликта с /api и статикой клиента. */
const PAGE_PATH_PATTERN = /^\/[a-z0-9][a-z0-9-]{1,31}(\/[a-z0-9][a-z0-9-]{1,31})?$/
/** Ротация журнала по умолчанию (ревью F9): 1 МиБ, одна архивная копия. */
const DEFAULT_JOURNAL_MAX_BYTES = 1048576
/** Суффикс durable-снимка своего ref'а в credential-store (R2: переживает рестарт и kill -9). */
const SNAPSHOT_SUFFIX = '_SNAPSHOT'
/** Маркеры снимка: ref до нас был пуст / исходное значение не установить (ref уже был подменён). */
const SNAPSHOT_ABSENT = 'MCP_ACCESS_SNAPSHOT_ABSENT'
const SNAPSHOT_UNKNOWN = 'MCP_ACCESS_SNAPSHOT_UNKNOWN'
/** Паузы авто-ретрая шлюза (R3) и период фоновых попыток, пока состояние degraded. */
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 9000]
const DEFAULT_RETRY_BACKGROUND_MS = 300000
const MAX_BODY_BYTES = 65536
const MAX_TMP_RENAME_ATTEMPTS = 5

/**
 * Резолв host-пакетов из рантайма DSH, а не из каталога плагина: плагин живёт вне профиля,
 * bare-спецификаторы '@deepseek-ai/...' из его модуля не резолвятся. Точка входа хоста
 * (process.argv[1] = .../dsh/lib/bin.js) даёт тот же realpath модуля, что уже загружен хостом
 * (важно для резерва serverName — модульный WeakMap, PKG/dsh-mcp-client/lib/index.js:767-773).
 *
 * @param {string} spec - bare-спецификатор пакета.
 * @returns {string} абсолютный путь к файлу входа пакета.
 */
function hostResolve(spec) {
  const bases = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') bases.push(process.argv[1])
  const roots = [
    process.env.DSH_PACKAGE_ROOT,
    '/home/seva/dsh-prod021-pkg',
    join(homedir(), 'dsh-prod021-pkg'),
  ].filter((root) => typeof root === 'string' && root !== '')
  for (const root of roots) bases.push(join(root, 'package.json'))
  const failures = []
  for (const base of bases) {
    try {
      return createRequire(base).resolve(spec)
    } catch (error) {
      failures.push(String(error && error.message ? error.message : error))
    }
  }
  throw new Error('dsh-mcp-access: cannot resolve host package "' + spec + '" (tried ' + bases.length + ' bases): ' + (failures[0] || ''))
}

/**
 * Каталоги node_modules хоста, где искать пакет вручную: createRequire().resolve не умеет
 * ESM-only пакеты без условия "require" (например @earendil-works/pi-ai: exports "." объявлен
 * только как import), а драйверу маршрута нужен именно он.
 * @returns {string[]} абсолютные пути существующих каталогов node_modules.
 */
function hostNodeModulesDirs() {
  const dirs = []
  const roots = [process.env.DSH_PACKAGE_ROOT, '/home/seva/dsh-prod021-pkg', join(homedir(), 'dsh-prod021-pkg')]
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    dirs.push(join(root, 'node_modules'))
    dirs.push(join(root))
  }
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') {
    dirs.push(join(dirname(process.argv[1]), 'node_modules'))
    dirs.push(join(dirname(process.argv[1]), '..'))
  }
  return [...new Set(dirs)].filter((dir) => existsSync(dir))
}

/**
 * Собрать file:// URL модуля ESM-only пакета по его exports-карте (без createRequire).
 * @param {string} spec - имя пакета ('@scope/name').
 * @param {string} [subpath] - подпуть без './' ('api/openai-completions'); '' — корень пакета.
 * @returns {string} file:// URL точки входа.
 */
function hostModuleUrl(spec, subpath = '') {
  const wanted = subpath === '' ? '.' : './' + subpath
  for (const dir of hostNodeModulesDirs()) {
    const packageDir = join(dir, spec)
    if (!existsSync(join(packageDir, 'package.json'))) continue
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    const exportsMap = pkg.exports
    let target = ''
    if (typeof exportsMap === 'string') target = exportsMap
    else if (exportsMap !== null && typeof exportsMap === 'object') {
      const entry = exportsMap[wanted]
      if (typeof entry === 'string') target = entry
      else if (entry !== null && typeof entry === 'object') target = entry.import || entry.default || ''
      if (target === '') {
        for (const key of Object.keys(exportsMap)) {
          if (!key.includes('*')) continue
          const [prefix, suffix] = key.split('*')
          if (!wanted.startsWith(prefix) || !wanted.endsWith(suffix)) continue
          const middle = wanted.slice(prefix.length, wanted.length - suffix.length)
          const value = exportsMap[key]
          const pattern = typeof value === 'string' ? value : (value && (value.import || value.default)) || ''
          if (pattern !== '') target = pattern.split('*').join(middle)
          break
        }
      }
    }
    if (target === '' && wanted === '.') target = pkg.module || pkg.main || './index.js'
    if (target === '') continue
    return pathToFileURL(join(packageDir, target)).href
  }
  throw new Error('dsh-mcp-access: cannot locate ESM package "' + spec + (subpath === '' ? '' : '/' + subpath) + '" in host node_modules')
}

const z = (await import(pathToFileURL(hostResolve('@deepseek-ai/schemastery')).href)).default
const McpClient = await import(pathToFileURL(hostResolve('@deepseek-ai/dsh-mcp-client')).href)
const { credentialRef } = await import(pathToFileURL(hostResolve('@deepseek-ai/dsh-credentials')).href)
const { scopeOf } = await import(pathToFileURL(hostResolve('@deepseek-ai/dsh-scope')).href)
// yaml нужен аварийному пути восстановления ref'а в обход закрытого сервиса credentials (R2-b).
const YAML = await import(pathToFileURL(hostResolve('yaml')).href)
// Свой llm-маршрут: провайдер с ДИНАМИЧЕСКИМ каталогом моделей. Стриминг/ретраи/картинки берёт
// на себя pi-ai + PiAiAdapter, плагин владеет только каталогом (права активного ключа).
import { buildGatewayRoute } from './lib/gateway-route.js'

export const name = 'verme-gate'
/** connection обязателен: без него ручки не имеют права работать (fail-closed, ревью P1-1). */
export const inject = ['tools', 'llm', 'credentials', 'webServer', 'connection']

/**
 * Сервер = строка шлюза. Плагин НЕ хранит транспорт/команды: всё, что за шлюзом, — streamable-http на
 * <gatewayBaseUrl>/<name>/mcp. Конфиг добавляет только то, чего шлюз не расскажет виртуальному ключу:
 * header-режим личного токена (tokenHeader/tokenRef) и дефолтный allowlist тулзов.
 */
const ServerConfig = z.object({
  /** server_name в шлюзе (registry GET /v1/mcp/server). */
  name: z.string().required(),
  label: z.string().default(''),
  /** Неймспейс mcp-client; по умолчанию = name. */
  serverName: z.string().default(''),
  /** header-режим (FR-013a): имя заголовка, куда кладётся личный токен, например X-Redmine-User-Key. */
  tokenHeader: z.string().default(''),
  /** Префикс значения заголовка (для X-Redmine-User-Key пустой). */
  tokenHeaderPrefix: z.string().default(''),
  /** credential-ref личного токена сервера (обязан быть MCP_ACCESS_*); по умолчанию MCP_ACCESS_T_<NAME>_TOKEN. */
  tokenRef: z.string().default(''),
  /** Пустое поле токена при header-режиме: true — сервер не монтируется (помечается «нет токена»). */
  tokenRequired: z.boolean().default(true),
  /**
   * RAW-имя тулза MCP для проверки живости личного токена (например redmine_hdr-redmine_whoami).
   * Пусто — проверить нельзя, статус будет token-unknown (не «всё хорошо»).
   */
  verifyTool: z.string().default(''),
  /** Дефолтный allowlist raw-имён тулзов; перекрывается грантом токена. Пусто = все тулзы сервера. */
  toolAllow: z.array(String).default([]),
  toolCallTimeoutMs: z.number().default(180000),
  reconnectMaxAttempts: z.number().step(1).default(60),
  /** Сколько раз пытаться смонтировать сервер, прежде чем оставить статус «ошибка». */
  mountRetryAttempts: z.number().step(1).default(3),
  /** Сколько ждать активации сервера, прежде чем повторить попытку. */
  mountTimeoutMs: z.number().default(8000),
})

const ServerGrant = z.object({
  server: z.string().required(),
  /** Пустой список = сервер открыт целиком; иначе ровно эти raw-имена тулзов шлюза. */
  tools: z.array(String).default([]),
})

const AccessToken = z.object({
  id: z.string().required(),
  label: z.string().default(''),
  servers: z.array(ServerGrant).default([]),
  /**
   * Credential-ref LiteLLM-ключа этого токена доступа (обязан быть MCP_ACCESS_*). Источник правды по
   * моделям — ключ: GET /v1/models отдаёт ровно разрешённые модели, чужую модель шлюз режет 403.
   */
  keyRef: z.string().default(''),
  /** Необязательное пересечение с /v1/models (FR-002 «models[]»); пусто = все модели ключа. */
  models: z.array(String).default([]),
  /** Задел под будущий путь SSO → группа → роль (FR-002a): на MVP-поведение не влияет. */
  group: z.string().default(''),
  source: z.string().default('manual'),
})

export const Config = z.object({
  /** Серверы шлюза, которым нужна наша донастройка (header-режим, дефолтный allowlist). */
  servers: z.array(ServerConfig).default([]),
  tokens: z.array(AccessToken).default([]),
  /** Активный токен по умолчанию (перекрывается stateFile, который пишет страница). */
  activeToken: z.string().default(''),
  /** Путь страницы (exact-route веб-сервера), например /mcp-access. */
  pagePath: z.string().default('/verme-gate'),
  /** Файл состояния активного токена; по умолчанию $DSH_HOME/storages/dsh-mcp-access.json. */
  stateFile: z.string().default(''),
  /** Журнал плагина (доказательства живых прогонов). */
  logFile: z.string().default(''),
  /** Предел журнала до ротации, байт (F9). */
  journalMaxBytes: z.number().step(1).default(DEFAULT_JOURNAL_MAX_BYTES),
  /** База шлюза для MCP: <gatewayBaseUrl>/<server>/mcp и <gatewayBaseUrl>/v1/... */
  gatewayBaseUrl: z.string().default('https://ai-labs-litellm.verme.ru'),
  /**
   * Id маршрута моделей. Плагин ВЛАДЕЕТ им: объявляет провайдера сам (createProvider +
   * PiAiAdapter + ctx.llm.registerAdapter), поэтому каталог в селекторе = права активного ключа,
   * без пересборки бандла. Провайдер с этим id НЕ должен быть объявлен в cordis.patch.yml;
   * '' — свои модели не поднимаем, работает только ключ в llmSecretRef.
   */
  llmProvider: z.string().default('dshlab'),
  /**
   * Credential-ref, который резолвит провайдер (его apiKeyEnv). ОБЯЗАН начинаться с MCP_ACCESS_:
   * плагин не имеет права перезаписывать чужие/общие ключи (ревью P1-2/F2).
   */
  llmSecretRef: z.string().default('MCP_ACCESS_LLM_KEY'),
  /** Base URL шлюза для GET {llmBaseUrl}/models (дефолт — прод-шлюз ai-labs; переопределяется для стендов). */
  llmBaseUrl: z.string().default('https://ai-labs-litellm.verme.ru/v1'),
  /** Сужать каталог до ответа /v1/models ключа (без отказа в request-path — 403 отдаёт шлюз). */
  modelSync: z.boolean().default(true),
  /**
   * Как часто перечитывать каталог моделей у шлюза, мс (0 — не перечитывать).
   * Права ключа меняются на шлюзе без нашего участия: без таймера селектор держит старый набор
   * до смены токена/записи ключа/ручного «Обновить»/рестарта.
   */
  modelRefreshMs: z.number().step(1).default(300000),
  /**
   * Ручные ёмкости моделей поверх ответа шлюза: id → {contextWindow?, maxTokens?}.
   * Шлюз отдаёт max_input_tokens/max_output_tokens не для всех моделей; без этой карты остальным
   * достаётся дефолт 131072, и автокомпакт срабатывает раньше реального окна.
   */
  modelLimits: z.dict(z.object({
    contextWindow: z.number(),
    maxTokens: z.number(),
  })).default({}),
  /**
   * Окно, объявляемое модели, про которую шлюз молчит (нет max_input_tokens). Это главная ручка
   * «на каком объёме компактить»: DSH считает порог как min(0.8·окно, окно − вывод − headroom),
   * поэтому 131072 даёт компакт на 65536, а 327680 — ровно на 262144 (0.8·327680).
   */
  defaultContextWindow: z.number().step(1).default(131072),
  /** Вывод, объявляемый такой модели (просьба к модели, не резерв порога). */
  defaultMaxTokens: z.number().step(1).default(32768),
  /**
   * Дефолтный уровень размышлений маршрута («thinking»). Применяется, когда агент/сессия не задал
   * свой: dsh-llm-pi-ai берёт его из профиля маршрута (streamWithSnapshot: options.reasoningEffort
   * ?? profile.reasoning). Раньше был жёстко 'low' — при молчащем профиле агента это давало
   * «у всех low». 'off' на этом шлюзе = минимальный уровень, а не отключение (карта THINKING_LEVEL_MAP).
   */
  defaultReasoningEffort: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /**
   * Переписывать конфиг DSH (saveSelection), когда выбранной модели больше нет в правах ключа.
   * По умолчанию false: плагин подставляет модель только в памяти и пишет об этом в журнал/панель.
   */
  persistDefaultModelSwap: z.boolean().default(false),
  /**
   * Переставлять модель у ЖИВЫХ агентов при потере модели. По умолчанию false: подмена идёт
   * только для новых сессий (дефолт), а начатая работа не меняет модель посреди диалога.
   */
  reselectAgentsOnModelLoss: z.boolean().default(false),
  /**
   * Потолок объявленного вывода (maxTokens), токенов; 0 — не ограничивать.
   * Шлюз иногда отдаёт вывод размером с пол-окна (opus: 200000/64000), а DSH вычитает объявленный
   * вывод из окна целиком: порог автокомпакта = min(0.8·окно, окно − вывод − headroom),
   * то есть 64k вывода съедают 64k из 200k и компакт приходит на ~69k.
   */
  maxOutputTokensCap: z.number().step(1).default(32768),
  /**
   * Headroom автокомпакта, токенов — ТОЛЬКО для диагностики (порог в /api/state).
   * Должен совпадать с настройкой compaction-basic в пресете агента: умолчание DSH 65536,
   * в пресетах с явной настройкой бывает 8192 (проверь свой пресет).
   */
  compactionHeadroomTokens: z.number().step(1).default(65536),
  /** Доля окна для порога автокомпакта — тоже только для диагностики (умолчание DSH 0.8). */
  compactionThresholdRatio: z.number().default(0.8),
  /** Таймаут discovery-запроса (реестр, статус env, модели), мс. */
  /** Таймаут одного запроса к шлюзу: под серией переключений 8 с не хватало (ловили abort). */
  modelDiscoveryTimeoutMs: z.number().default(20000),
  retryDelaysMs: z.array(z.number()).default(DEFAULT_RETRY_DELAYS_MS),
  retryBackgroundMs: z.number().default(DEFAULT_RETRY_BACKGROUND_MS),
  /** Таймаут одной проверки verifyTool, мс: MCP недоступен -> token-unknown, инстанс жив. */
  verifyTimeoutMs: z.number().default(10000),
  /** Кеш результата проверки (пока отпечаток токена тот же), мс. */
  verifyTtlMs: z.number().default(300000),
  /**
   * Каталог промптов-инструкций (markdown), которые экран предлагает отправить в сессию.
   * Читаются только файлы *.md в этом каталоге (без рекурсии); пусто — встроенный набор из
   * prompts/ пакета (сейчас там инструкция по браузерному MCP). Своя копия набора —
   * deploy/dsh-bootstrap в монорепозитории.
   */
  promptsDir: z.string().default(''),
  /**
   * Кеш ответа шлюза о бюджете ключа (/key/info, /user/info), мс: экран настроек опрашивает
   * состояние часто, а расход меняется медленно. 0 — спрашивать шлюз каждый раз.
   */
  budgetRefreshMs: z.number().min(0).default(60000),
})

/**
 * Публичное имя MCP-тулза — точная копия алгоритма PKG/dsh-mcp-client/lib/index.js:85-100:
 * mcp__<server>__<raw>, нормализация в [A-Za-z0-9_-]{1,64}, при потере — 12 hex sha256.
 *
 * @param {string} serverName - неймспейс сервера.
 * @param {string} rawName - имя тулза на стороне шлюза.
 * @returns {string} model-facing имя тулза.
 */
function publicToolName(serverName, rawName) {
  const joined = 'mcp__' + serverName + '__' + rawName
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(serverName + '\u0000' + rawName).digest('hex').slice(0, HASH_LENGTH)
  return normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1) + '_' + hash
}

/**
 * Дефолтный credential-ref для личного токена сервера (POSIX-identifier, своё пространство имён).
 * @param {string} serverName - имя сервера в шлюзе.
 * @returns {string} имя ref'а.
 */
function defaultTokenRef(serverName) {
  return OWN_REF_PREFIX + 'T_' + serverName.toUpperCase().replace(/[^A-Za-z0-9_]/g, '_') + '_TOKEN'
}

/**
 * Credential-ref набора заголовков сервера (JSON {"<Header>": "<value>"}): сервис требует от клиента
 * собственные заголовки (например X-Redmine-User-Key) — значение живёт в credential-store, не в конфиге.
 * @param {string} serverName - имя сервера в шлюзе.
 * @returns {string} имя ref'а.
 */
function serverHeadersRef(serverName) {
  return OWN_REF_PREFIX + 'SRV_' + String(serverName).toUpperCase().replace(/[^A-Za-z0-9_]/g, '_') + '_HEADERS'
}

/** Допустимое имя HTTP-заголовка (RFC 7230 token). */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/

/**
 * Имена заголовков, которые сервис называет сам в своём описании в шлюзе
 * («PDM/Redmine под ключом из заголовка X-Redmine-User-Key»). Шлюз не отдаёт extra_headers
 * пользовательскому ключу (они admin-only), поэтому описание записи — единственный
 * пользовательский источник имени; человек всегда может поправить имя в экране.
 * @param {string} description - описание сервера из реестра шлюза.
 * @returns {string[]} имена заголовков (не больше трёх).
 */
function headerNamesFromDescription(description) {
  const text = String(description || '')
  if (text === '') return []
  const match = /(заголов\w*|headers?)([^.;)]{0,120})/i.exec(text)
  if (match === null) return []
  const names = []
  for (const candidate of match[2].match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+/g) || []) {
    if (!HEADER_NAME_PATTERN.test(candidate)) continue
    // X-… — почти всегда имя заголовка; прочие составные слова («per-user») отсекаем.
    const headerish = /^x-/i.test(candidate)
      || (/^[A-Z]/.test(candidate) && candidate.split('-').length >= 3)
    if (headerish && !names.includes(candidate)) names.push(candidate)
    if (names.length >= 3) break
  }
  return names
}

/** Допустимый id токена, созданного через экран: латиница, цифры, дефис; начинается с буквы. */
const TOKEN_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

/**
 * Credential-ref LiteLLM-ключа для токена, созданного через экран.
 * @param {string} tokenId - id токена.
 * @returns {string} имя ref'а в пространстве плагина.
 */
function tokenKeyRef(tokenId) {
  return OWN_REF_PREFIX + String(tokenId).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_LITELLM_KEY'
}

/** Транслитерация для внутреннего id токена, созданного из названия. */
const SLUG_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/**
 * Собрать внутренний id токена из названия: латиница/цифры/дефис, 2–32 символа, начинается с буквы.
 * @param {string} label - название токена, как его ввёл человек.
 * @returns {string} id (возможно, невалидный — проверяется вызывающим).
 */
function slugTokenId(label) {
  const ascii = String(label || '').toLowerCase().split('').map((char) => {
    if (SLUG_MAP[char] !== undefined) return SLUG_MAP[char]
    return /[a-z0-9]/.test(char) ? char : '-'
  }).join('')
  const slug = ascii.replace(/-+/g, '-').replace(/^-|-$/g, '').replace(/^[^a-z]+/, '').slice(0, 32)
  return slug === '' ? '' : slug
}

/**
 * Нормализовать Config в карты серверов и токенов.
 * @param {object} config - валидированный Config.
 * @returns {{servers: Map<string, object>, tokens: Map<string, object>}} нормализованная модель конфига.
 */
function normalizeConfig(config) {
  const servers = new Map()
  for (const server of Array.isArray(config.servers) ? config.servers : []) {
    const serverName = String(server.name)
    if (serverName === '') continue
    servers.set(serverName, Object.assign({}, server, {
      name: serverName,
      serverName: server.serverName !== '' ? server.serverName : serverName,
      tokenRef: server.tokenRef !== '' ? server.tokenRef : (server.tokenHeader !== '' ? defaultTokenRef(serverName) : ''),
    }))
  }
  const tokens = new Map()
  for (const token of Array.isArray(config.tokens) ? config.tokens : []) {
    const id = String(token.id)
    if (id === '') continue
    const grants = new Map()
    for (const grant of Array.isArray(token.servers) ? token.servers : []) {
      const granted = String(grant.server)
      if (granted === '') continue
      const tools = (Array.isArray(grant.tools) ? grant.tools : []).filter((tool) => typeof tool === 'string' && tool !== '')
      grants.set(granted, { tools, all: tools.length === 0 })
    }
    tokens.set(id, {
      id,
      label: typeof token.label === 'string' ? token.label : '',
      servers: grants,
      keyRef: typeof token.keyRef === 'string' ? token.keyRef : '',
      models: (Array.isArray(token.models) ? token.models : []).filter((model) => typeof model === 'string' && model !== ''),
      group: typeof token.group === 'string' ? token.group : '',
      source: typeof token.source === 'string' ? token.source : 'manual',
    })
  }
  return { servers, tokens }
}

/**
 * Плагин: поднимает гейты и страницу; активный токен применяется на старте и на переключении.
 * @param {object} ctx - корневой контекст композиции.
 * @param {object} config - валидированный Config.
 */
export function apply(ctx, config) {
  const cfg = config || {}
  const catalog = normalizeConfig(cfg)
  /** Токены, созданные через экран: живут в stateFile, а не в конфиге оператора. */
  const uiTokens = new Map()
  /** Токены конфига, скрытые в этом DSH: запись в конфиге остаётся, экран и агенты её не видят. */
  const hiddenTokens = new Set()
  /**
   * Токен существует и не скрыт — его можно выбрать, применить и дать ему ключ.
   * @param {unknown} id - id токена.
   * @returns {boolean} true, если токен доступен.
   */
  const hasToken = (id) => typeof id === 'string' && id !== '' && catalog.tokens.has(id) && !hiddenTokens.has(id)
  /** @returns {object[]} токены для экрана и для выбора активного (скрытые не попадают). */
  const visibleTokens = () => [...catalog.tokens.values()].filter((token) => !hiddenTokens.has(token.id))
  /**
   * Свободный id на основе занятого: base, base-2, base-3…
   * @param {string} base - желаемый id.
   * @returns {string} свободный id.
   */
  const uniqueTokenId = (base) => {
    if (!catalog.tokens.has(base)) return base
    for (let index = 2; index < 100; index += 1) {
      const candidate = base.slice(0, 28) + '-' + index
      if (!catalog.tokens.has(candidate)) return candidate
    }
    return base + '-' + randomUUID().slice(0, 8)
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const configErrors = []
  const configWarnings = []

  /* ─────────────────────── валидация конфига (ревью F10) ─────────────────────── */

  const rawPagePath = typeof cfg.pagePath === 'string' && cfg.pagePath !== '' ? cfg.pagePath : '/verme-gate'
  let pagePath = ''
  if (!PAGE_PATH_PATTERN.test(rawPagePath)) {
    configErrors.push('pagePath "' + rawPagePath + '" недопустим: нужен вид /<slug> или /<slug>/<slug>'
      + ' (нижний регистр, дефисы), без "/" и без пересечения с /api и статикой клиента — страница и API не подняты')
  } else {
    pagePath = rawPagePath
  }

  /**
   * Абсолютный путь; stateFile обязан лежать внутри DSH_HOME, журнал может быть вынесен наружу
   * (доказательства живых прогонов лежат в репозитории), но обязан быть абсолютным.
   * @param {unknown} value - значение из конфига.
   * @param {string} fallback - значение по умолчанию.
   * @param {string} label - имя поля для сообщения.
   * @param {boolean} insideHome - требовать ли расположения внутри DSH_HOME.
   * @returns {string} принятый путь ('' — ошибка конфига).
   */
  const validatePath = (value, fallback, label, insideHome) => {
    const path = typeof value === 'string' && value !== '' ? value : fallback
    if (path === '') return ''
    if (!path.startsWith('/')) {
      configErrors.push(label + ' "' + path + '" должен быть абсолютным путём (относительный зависит от CWD процесса)')
      return ''
    }
    if (insideHome && !path.startsWith(dshHome + '/')) {
      configErrors.push(label + ' "' + path + '" должен лежать внутри DSH_HOME (' + dshHome + ')')
      return ''
    }
    if (!insideHome && !path.startsWith(dshHome + '/')) {
      configWarnings.push(label + ' "' + path + '" вне DSH_HOME — пишем туда, куда указал оператор')
    }
    return path
  }

  const stateFile = validatePath(cfg.stateFile, join(dshHome, 'storages', 'dsh-mcp-access.json'), 'stateFile', true)
  const logFile = validatePath(cfg.logFile, '', 'logFile', false)
  const journalMaxBytes = Number(cfg.journalMaxBytes) > 4096 ? Number(cfg.journalMaxBytes) : DEFAULT_JOURNAL_MAX_BYTES

  /**
   * Ref'ы плагина обязаны быть в своём пространстве имён (ревью P1-2/F2).
   * @param {string} ref - имя ref'а.
   * @returns {boolean} true — можно писать.
   */
  const isOwnRef = (ref) => typeof ref === 'string' && ref.startsWith(OWN_REF_PREFIX) && REF_PATTERN.test(ref)

  if (String(cfg.llmSecretRef || '') !== '' && !isOwnRef(String(cfg.llmSecretRef))) {
    configErrors.push('llmSecretRef "' + cfg.llmSecretRef + '" вне пространства имён плагина (нужен ' + OWN_REF_PREFIX
      + '*): чужой credential-ref не перезаписывается, синхронизация моделей отключена')
  }
  for (const token of catalog.tokens.values()) {
    if (token.keyRef !== '' && !isOwnRef(token.keyRef)) {
      configWarnings.push('token "' + token.id + '": keyRef "' + token.keyRef + '" вне пространства ' + OWN_REF_PREFIX
        + '* — запись ключа через страницу запрещена')
    }
  }
  for (const server of catalog.servers.values()) {
    if (!SERVER_NAME_PATTERN.test(server.serverName)) {
      configErrors.push('server "' + server.name + '": serverName "' + server.serverName + '" не проходит ^[A-Za-z0-9_-]{1,32}$')
    }
    if (server.tokenRef !== '' && !isOwnRef(server.tokenRef)) {
      configErrors.push('server "' + server.name + '": tokenRef "' + server.tokenRef + '" вне пространства ' + OWN_REF_PREFIX + '*')
    }
    if (server.tokenRef !== '' && server.tokenHeader === '') {
      configErrors.push('server "' + server.name + '": задан tokenRef без tokenHeader — личный токен некуда положить')
    }
    // verifyTool разрешён в любом режиме: header-режим проверяется личным токеном, client-headers —
    // сохранёнными заголовками, gateway — вызовом через шлюз (значение лежит у него в user env vars).
  }
  const modelSyncEnabled = cfg.modelSync === true && String(cfg.llmProvider || '') !== ''
    && isOwnRef(String(cfg.llmSecretRef || '')) && String(cfg.llmBaseUrl || '') !== ''
  const routesEnabled = pagePath !== '' && stateFile !== ''

  const state = {
    activeToken: '',
    /** 'starting' | 'switching' | 'ready' | 'degraded' — фаза применения (ревью P1-3). */
    phase: 'starting',
    /** Барьер fail-closed: пока true, все управляемые MCP-тулзы запрещены всем агентам. */
    barrier: false,
    /** Сколько применений ждёт в очереди (ревью P1-4). */
    applyPending: 0,
    /** serverName → { name, status, serverName, tokenRef, fiber, mountedAt, error, url, setupUrl } */
    mounts: new Map(),
    /** serverName → { name, serverName, all, tools:Set<raw> } — ЭФФЕКТИВНЫЕ (закоммиченные) гранты. */
    grants: new Map(),
    /** serverName, которыми владеет плагин в текущем поколении. */
    managedNames: new Set(),
    /** Все serverName, которыми плагин когда-либо владел: барьер и гейт обязаны их помнить. */
    everManaged: new Set(),
    /** serverName → запись реестра шлюза (GET /v1/mcp/server ключом активного токена). */
    registry: new Map(),
    /** Состав последнего удачного реестра: по нему рисуются строки, когда реестра нет («Отключить»). */
    lastServerNames: [],
    /** serverName → { serverId, alias, required, missingCount, setupUrl } (GET /v1/mcp/user-env-vars/status). */
    envStatus: new Map(),
    /** Синтезированные серверы реестра, которых нет в конфиге (неймспейс = имя шлюза). */
    runtime: new Map(),
    registryError: '',
    envStatusError: '',
    keyHealthError: '',
    registryWarnings: [],
    registryAt: 0,
    /** agent → { label, agent, ctx, scope, hidden:Set, disposers:[] } */
    agents: new Map(),
    lastError: '',
    /** Предупреждения о снимке ref'а (R2): ref уже был подменён до нас / снимок UNKNOWN. */
    snapshotWarnings: [],
    /** serverName → { server, status: 'token-ok'|'token-rejected'|'token-unknown', httpCode, reason, login, checkedAt, fingerprint } */
    verify: new Map(),
    /** Имена управляемых тулзов, которые плагин видел: по ним считается запрет даже после снятия тулза. */
    knownManagedTools: new Set(),
    /** serverName → счётчик сбросов вердикта: результат проверки, начатой до записи, отбрасывается. */
    verifyEpoch: new Map(),
    /** serverName с отвергнутым токеном: тулзы сервера запрещены агентам (fail-closed), фаза degraded. */
    tokenRejected: new Set(),
    /** Журнал восстановления своих ref'ов (R2-b): [{ ref, status: ok|pending|skipped, via, reason, at }]. */
    restores: [],
    /** Сколько живых агентов плагин увидел в реестре и скольким из них применён гейт (R7). */
    agentsSeen: 0,
    agentsGated: 0,
    agentsUngated: [],
    generation: 0,
    configErrors,
    configWarnings,
  }

  /* ─────────────────────── журнал: агрегированный, асинхронный, с ротацией ─────────────────────── */

  let journalBytes = 0
  let journalChain = Promise.resolve()
  let journalBroken = false
  let journalLines = 0

  /** Прочитать текущий размер журнала (для ротации без stat на каждую строку). */
  const initJournalSize = async () => {
    if (logFile === '') return
    try {
      journalBytes = (await stat(logFile)).size
      // Файл мог достаться от прежних версий с правами 644: журнал содержит текст чужих ошибок.
      await chmod(logFile, 0o600)
    } catch {
      journalBytes = 0
    }
  }

  /**
   * Дописать строку в журнал: async append, агрегация гейтов вызывающей стороной, ротация по размеру.
   * @param {string} line - текст без префикса/времени.
   */
  const journal = (line) => {
    if (logFile === '' || journalBroken) return journalChain
    const text = new Date().toISOString() + ' ' + line + '\n'
    journalBytes += Buffer.byteLength(text)
    journalLines += 1
    journalChain = journalChain.then(async () => {
      try {
        if (journalBytes > journalMaxBytes) {
          await rename(logFile, logFile + '.1')
          journalBytes = Buffer.byteLength(text)
          journalLines = 1
        }
        // Журнал может содержать текст ошибок апстрима: создаём с правами только для владельца.
        await appendFile(logFile, text, { mode: 0o600 })
      } catch (error) {
        journalBroken = true
        console.log(LOG_PREFIX + ' journal disabled: ' + String(error && error.message ? error.message : error))
      }
    })
    return journalChain
  }

  /** Дождаться, пока журнал допишется (для тестов/аккуратного dispose). */
  const journalFlush = () => journalChain

  /**
   * Лог через logger контекста с фолбэком в консоль.
   * @param {string} level - 'info' | 'warn' | 'error'.
   * @param {string} message - шаблон.
   * @param {...unknown} args - аргументы шаблона.
   */
  const log = (level, message, ...args) => {
    const target = ctx.logger && (ctx.logger[level] || ctx.logger.warn)
    const text = LOG_PREFIX + ' ' + message
    if (typeof target === 'function') target.call(ctx.logger, text, ...args)
    else console.log(text, ...args)
  }

  const messageOf = (error) => String(error && error.message ? error.message : error)

/**
 * Вычистить из текста апстрима то, что похоже на предъявленный секрет: ошибки шлюза и MCP иногда
 * эхом возвращают Authorization/X-…-Key, а этот текст попадает в журнал и в /api/state.
 * @param {string} text - текст ошибки/ответа.
 * @returns {string} текст без похожих на секрет фрагментов.
 */
const sanitizeUpstream = (text) => String(text === undefined || text === null ? '' : text)
  .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
  .replace(/((?:x-[a-z0-9-]*key|authorization|api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s,;"}]{8,}/gi, '$1<redacted>')
  .replace(/[A-Za-z0-9+/=_-]{40,}/g, '<redacted>')

  /* ─────────────────────── сериализация применений (ревью P1-4/F5) ─────────────────────── */

  let applyChain = Promise.resolve()

  /**
   * Выполнить применение строго после предыдущего (очередь, не отказ): параллельные
   * POST /api/active должны все завершиться успешно, просто по очереди.
   * @param {() => Promise<unknown>} task - работа.
   * @returns {Promise<unknown>} результат.
   */
  const serialise = (task) => {
    state.applyPending += 1
    const run = applyChain.then(task, task)
    applyChain = run.then(() => undefined, () => undefined)
    const settle = () => {
      state.applyPending -= 1
    }
    run.then(settle, settle)
    return run
  }

  /* ─────────────────────── активный токен и его гранты ─────────────────────── */

  const activeGrant = () => catalog.tokens.get(state.activeToken)

  /** Состояние модельной части под активным токеном (источник — LiteLLM-ключ). */
  const modelState = {
    keyRef: '',
    keyState: 'idle',
    allowed: new Set(),
    /** Ёмкости из ответа шлюза: id -> { contextWindow?, maxTokens? } (есть не у всех моделей). */
    limits: new Map(),
    known: false,
    degraded: false,
    error: '',
    fetchedAt: 0,
    baseUrl: '',
    provider: '',
    /** Последняя подмена дефолтной модели: { at, from, to, persisted } — показывается в панели. */
    defaultSwap: null,
  }

  const gatewayBase = () => String(cfg.gatewayBaseUrl || '').replace(/\/+$/, '')

  /**
   * Прочитать секрет из credential-store.
   * @param {string} ref - имя ref'а.
   * @returns {Promise<string>} значение либо '' (нет ref / нет значения).
   */
  const readSecret = async (ref) => {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return ''
    try {
      const hit = await ctx.credentials.resolve(credentialRef(ref))
      return hit && typeof hit.value === 'string' ? hit.value : ''
    } catch {
      return ''
    }
  }

  /**
   * Факт наличия секрета (значение наружу не отдаётся, NFR-002).
   * @param {string} ref - имя ref'а.
   * @returns {Promise<{configured: boolean, source?: string}>} статус.
   */
  const describeSecret = async (ref) => {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return { configured: false }
    try {
      const info = await ctx.credentials.describe(credentialRef(ref))
      return { configured: info.configured === true, source: info.source }
    } catch {
      return { configured: false }
    }
  }

  /**
   * Что сервер требует от клиента в заголовках: имена из записи шлюза (extra_headers — когда шлюз их
   * отдаёт) плюс те, что сервис сам называет в описании. Устаревший tokenHeader из конфига учитывается
   * тем же путём, поэтому старые конфиги продолжают работать.
   * @param {object} server - нормализованный сервер.
   * @param {object|undefined} record - запись реестра шлюза.
   * @returns {string[]} имена заголовков к заполнению.
   */
  const requiredHeaderNames = (server, record) => {
    const names = []
    const push = (name) => {
      if (typeof name !== 'string' || name === '') return
      if (!HEADER_NAME_PATTERN.test(name) || names.includes(name)) return
      names.push(name)
    }
    if (server !== undefined && server.tokenHeader !== '') push(server.tokenHeader)
    if (record !== undefined) {
      for (const name of Array.isArray(record.extraHeaders) ? record.extraHeaders : []) push(name)
      for (const name of headerNamesFromDescription(record.description)) push(name)
    }
    return names
  }

  /**
   * Прочитать заголовки сервера из credential-store (один JSON-секрет на сервер).
   * @param {string} serverName - имя сервера в шлюзе.
   * @returns {Promise<Record<string, string>>} имя заголовка → значение.
   */
  const readServerHeaders = async (serverName) => {
    const raw = await readSecret(serverHeadersRef(serverName))
    if (raw === '') return {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return {}
      const headers = {}
      for (const [name, value] of Object.entries(parsed)) {
        if (HEADER_NAME_PATTERN.test(name) && typeof value === 'string' && value !== '') headers[name] = value
      }
      return headers
    } catch {
      return {}
    }
  }

  /**
   * Записать заголовки сервера; пустой набор снимает ref (значения живут только здесь, NFR-002).
   * @param {string} serverName - имя сервера в шлюзе.
   * @param {Record<string, string>} headers - заголовки.
   */
  const writeServerHeaders = async (serverName, headers) => {
    const ref = serverHeadersRef(serverName)
    if (!isOwnRef(ref)) throw new Error('ref "' + ref + '" вне пространства ' + OWN_REF_PREFIX + '*')
    if (Object.keys(headers).length === 0) {
      await ctx.credentials.unset(credentialRef(ref))
      return
    }
    await ctx.credentials.set(credentialRef(ref), JSON.stringify(headers))
  }

  /* ─────────────────────── снимок/восстановление своих ref'ов (ревью P1-2/F2) ─────────────────────── */

  /** ref → { present, value, unknown, restored } — прежние значения наших ref'ов до первой записи плагина. */
  const credentialSnapshots = new Map()
  let credentialSnapshotsRestored = false

  /** ref снимка в том же credential-store (R2): 'MCP_ACCESS_LLM_KEY' → 'MCP_ACCESS_LLM_KEY_SNAPSHOT'. */
  const snapshotRefOf = (ref) => ref + SNAPSHOT_SUFFIX

  /**
   * Запомнить текущее значение своего ref'а ДО первой записи плагина — durable (R2): снимок лежит
   * в credential-store плагина отдельным ref'ом, поэтому переживает рестарт и kill -9.
   * Уже существующий снимок НЕ перезаписывается: иначе второй запуск принял бы за «исходное»
   * то, что оставил первый. Если снимка нет, а ref уже содержит ключ активного токена —
   * считаем, что плагин поставлен на подменённый ref: пишем маркер UNKNOWN и предупреждаем.
   * @param {string} ref - свой ref (MCP_ACCESS_*).
   * @param {string} [expectedValue] - значение, которое плагин собирается записать (ключ токена).
   * @returns {Promise<void>} завершение.
   */
  const snapshotCredential = async (ref, expectedValue) => {
    if (!isOwnRef(ref) || credentialSnapshots.has(ref)) return
    const snapshotRef = snapshotRefOf(ref)
    if (!isOwnRef(snapshotRef)) return
    const durable = await readSecret(snapshotRef)
    if (durable !== '') {
      const unknown = durable === SNAPSHOT_UNKNOWN
      credentialSnapshots.set(ref, {
        present: durable !== SNAPSHOT_ABSENT,
        value: unknown || durable === SNAPSHOT_ABSENT ? '' : durable,
        unknown,
      })
      journal('credential snapshot ref=' + ref + ' loaded from store'
        + (durable === SNAPSHOT_ABSENT ? ' (ref был пуст)' : '')
        + (unknown ? ' (UNKNOWN: исходное значение установить нельзя)' : ' length=' + durable.length))
      if (unknown) {
        const warning = 'ref ' + ref + ' уже содержал ключ токена до старта плагина (снимок UNKNOWN): '
          + 'исходное значение восстановить нельзя, ref не будет перезаписан на dispose'
        if (!state.snapshotWarnings.includes(warning)) state.snapshotWarnings.push(warning)
      }
      return
    }
    const value = await readSecret(ref)
    if (value !== '' && expectedValue !== undefined && value === expectedValue) {
      credentialSnapshots.set(ref, { present: true, value: '', unknown: true })
      await ctx.credentials.set(credentialRef(snapshotRef), SNAPSHOT_UNKNOWN)
      const warning = 'ref ' + ref + ' уже содержал ключ активного токена до первого запуска плагина: '
        + 'похоже, плагин ставится на подменённый ref — исходное значение неизвестно (снимок UNKNOWN)'
      if (!state.snapshotWarnings.includes(warning)) state.snapshotWarnings.push(warning)
      journal('WARN credential snapshot ref=' + ref + ' UNKNOWN: ref уже содержит ключ активного токена')
      return
    }
    credentialSnapshots.set(ref, { present: value !== '', value, unknown: false })
    await ctx.credentials.set(credentialRef(snapshotRef), value === '' ? SNAPSHOT_ABSENT : value)
    journal('credential snapshot ref=' + ref + ' persist=' + snapshotRef
      + ' present=' + (value !== '') + (value !== '' ? ' length=' + value.length : ''))
  }

  /**
   * Файл credential-store этого дома ($DSH_HOME/.credentials.yaml).
   * @returns {string} абсолютный путь.
   */
  const credentialsFile = () => join(dshHome, '.credentials.yaml')

  /**
   * Аварийная запись/удаление ref'а напрямую в файл credential-store (R2-b).
   * Нужна на штатной остановке: сервис credentials-local к этому моменту уже закрыт
   * («credentials-local is disposed: cannot set …»), а durable-снимок обязан вернуться в ref.
   * Пишем атомарно (tmp + rename, режим 600) и подтверждаем результат чтением файла.
   * @param {string} ref - имя ref'а в store.
   * @param {string} value - значение; пустая строка — удалить ref.
   * @returns {Promise<boolean>} true — запись подтверждена чтением.
   */
  const emergencyCredentialWrite = async (ref, value) => {
    const file = credentialsFile()
    try {
      const text = await readFile(file, 'utf8').catch(() => '')
      const document = text.trim() === '' ? { version: 1 } : YAML.parse(text)
      if (document === null || typeof document !== 'object') return false
      const refs = document.refs !== null && typeof document.refs === 'object' && !Array.isArray(document.refs)
        ? document.refs
        : {}
      if (value === '') delete refs[ref]
      else refs[ref] = value
      document.refs = refs
      if (document.version === undefined) document.version = 1
      const tmp = file + '.tmp-restore-' + randomUUID()
      await writeFile(tmp, YAML.stringify(document), { mode: 0o600 })
      await rename(tmp, file)
      const check = YAML.parse(await readFile(file, 'utf8'))
      const actual = check && check.refs && typeof check.refs[ref] === 'string' ? check.refs[ref] : ''
      return actual === (value === '' ? '' : value)
    } catch (error) {
      log('warn', 'emergency credential write ref=' + ref + ': ' + messageOf(error))
      return false
    }
  }

  /**
   * Записать значение в свой ref: сначала штатным сервисом, при отказе (закрытый store на dispose) —
   * напрямую в файл store. Успех — только после подтверждения чтением.
   * @param {string} ref - свой ref (MCP_ACCESS_*).
   * @param {string} value - значение; пустая строка — удалить ref.
   * @returns {Promise<{ok: boolean, via: string, error: string}>} результат записи.
   */
  const writeOwnRef = async (ref, value) => {
    let serviceError = ''
    try {
      if (value === '') await ctx.credentials.unset(credentialRef(ref))
      else await ctx.credentials.set(credentialRef(ref), value)
      if ((await readSecret(ref)) === value) return { ok: true, via: 'service', error: '' }
      serviceError = 'readback mismatch'
    } catch (error) {
      serviceError = messageOf(error)
    }
    if (await emergencyCredentialWrite(ref, value)) return { ok: true, via: 'file', error: serviceError }
    return { ok: false, via: 'none', error: serviceError }
  }

  /**
   * Удалить durable-снимок ref'а (сервисом или аварийно файлом).
   * @param {string} snapshotRef - ref снимка.
   * @returns {Promise<{ok: boolean, error: string}>} результат.
   */
  const dropSnapshot = async (snapshotRef) => {
    let serviceError = ''
    try {
      await ctx.credentials.unset(credentialRef(snapshotRef))
      if ((await readSecret(snapshotRef)) === '') return { ok: true, error: '' }
      serviceError = 'readback mismatch'
    } catch (error) {
      serviceError = messageOf(error)
    }
    if (await emergencyCredentialWrite(snapshotRef, '')) return { ok: true, error: '' }
    return { ok: false, error: serviceError }
  }

  /**
   * Вернуть один ref из снимка; снимок удаляется ТОЛЬКО после подтверждённой записи.
   * Если записать нельзя — статус pending: снимок остаётся в store, восстановление повторится на старте.
   * @param {string} ref - свой ref.
   * @param {object} snapshot - { present, value, unknown }.
   * @param {string} source - 'dispose' | 'startup-pending'.
   * @returns {Promise<{status: string, via: string, reason: string}>} результат.
   */
  const restoreSnapshot = async (ref, snapshot, source) => {
    if (snapshot.unknown) {
      log('warn', 'restore ref ' + ref + ' skipped: исходное значение неизвестно (снимок UNKNOWN)')
      journal('restore ref=' + ref + ' status=skipped source=' + source
        + ' reason=снимок UNKNOWN, значение оставлено как есть')
      return { status: 'skipped', via: 'none', reason: 'снимок UNKNOWN' }
    }
    const value = snapshot.present ? snapshot.value : ''
    const written = await writeOwnRef(ref, value)
    if (!written.ok) {
      journal('restore ref=' + ref + ' status=pending source=' + source + ' reason=' + written.error
        + ' — снимок оставлен, восстановление повторится на следующем старте')
      return { status: 'pending', via: written.via, reason: written.error }
    }
    const dropped = await dropSnapshot(snapshotRefOf(ref))
    if (!dropped.ok) {
      journal('restore ref=' + ref + ' status=pending source=' + source
        + ' reason=ref восстановлен, снимок не удалён: ' + dropped.error)
      return { status: 'pending', via: written.via, reason: 'снимок не удалён: ' + dropped.error }
    }
    journal('restore ref=' + ref + ' status=ok source=' + source + ' via=' + written.via
      + ' value=' + (value === '' ? 'absent' : 'length=' + value.length))
    return { status: 'ok', via: written.via, reason: '' }
  }

  /**
   * Восстановить снятые снимки (dispose/HMR-выгрузка). Каждый ref получает статус ok|pending|failed
   * в журнале и в state.restores; снимок удаляется только после подтверждённой записи.
   * UNKNOWN-снимок: ref не трогаем, но громко предупреждаем (без молчаливой подмены).
   * @param {string} [source] - откуда вызвано ('dispose').
   * @returns {Promise<void>} завершение.
   */
  const restoreCredentialSnapshots = async (source) => {
    if (credentialSnapshotsRestored) return
    credentialSnapshotsRestored = true
    const from = source !== undefined ? source : 'dispose'
    for (const [ref, snapshot] of credentialSnapshots) {
      if (!isOwnRef(ref)) continue
      const result = await restoreSnapshot(ref, snapshot, from)
      state.restores.push({ ref, status: result.status, via: result.via, reason: result.reason, at: Date.now() })
      if (result.status === 'pending') {
        const warning = 'ref ' + ref + ' не восстановлен при остановке (запись невозможна): восстановление '
          + 'повторится на следующем старте, снимок ' + snapshotRefOf(ref) + ' оставлен'
        if (!state.snapshotWarnings.includes(warning)) state.snapshotWarnings.push(warning)
      }
    }
    credentialSnapshots.clear()
  }

  /**
   * Durable-фолбэк (R2-b): снимок, оставшийся от прошлого запуска, значит, что ref не удалось вернуть
   * на остановке. Восстановление приоритетнее захвата ref'а — выполняется ДО первой записи ключа
   * токена и до нового снимка; снимок удаляется только после подтверждённой записи.
   * @returns {Promise<boolean>} true — что-то восстановлено из pending.
   */
  const completePendingRestore = async () => {
    if (!modelSyncEnabled) return false
    const ref = String(cfg.llmSecretRef || '')
    if (!isOwnRef(ref)) return false
    const snapshotRef = snapshotRefOf(ref)
    if (!isOwnRef(snapshotRef)) return false
    const durable = await readSecret(snapshotRef)
    if (durable === '' || durable === SNAPSHOT_UNKNOWN) return false
    const snapshot = { present: durable !== SNAPSHOT_ABSENT, value: durable === SNAPSHOT_ABSENT ? '' : durable, unknown: false }
    journal('restore ref=' + ref + ' status=pending-detected (снимок от прошлого запуска, до захвата ref)')
    const result = await restoreSnapshot(ref, snapshot, 'startup-pending')
    state.restores.push({ ref, status: result.status, via: result.via, reason: result.reason, at: Date.now() })
    if (result.status === 'ok') journal('restore pending completed ref=' + ref)
    return result.status === 'ok'
  }

  /* ─────────────────── M1: реестр/статус шлюза и монтирование ─────────────────── */

  /**
   * GET к шлюзу ключом активного токена.
   * @param {string} path - путь, например '/v1/mcp/server'.
   * @param {string} key - LiteLLM-ключ.
   * @returns {Promise<{body?: unknown, status?: number, error?: string}>} ответ либо ошибка.
   */
  const gatewayGet = async (path, key) => {
    const base = gatewayBase()
    if (base === '') return { error: 'gatewayBaseUrl is not configured' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(cfg.modelDiscoveryTimeoutMs) || 20000)
    try {
      const response = await fetch(base + path, {
        headers: { authorization: 'Bearer ' + key },
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) return { status: response.status, error: 'GET ' + path + ' -> HTTP ' + response.status }
      try {
        return { status: response.status, body: JSON.parse(text) }
      } catch {
        return { status: response.status, error: 'GET ' + path + ': non-JSON answer' }
      }
    } catch (error) {
      return { error: 'GET ' + path + ' failed: ' + messageOf(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Запрос к шлюзу, который меняет состояние (POST/DELETE) — ключом активного токена.
   * Нужен для личных значений env var: их пишет сам пользователь своим ключом, без админки
   * LiteLLM (FR-020). Тело и ответ — JSON; текст ошибки шлюза отдаём наверх как есть.
   * @param {string} method - http-метод.
   * @param {string} path - путь, например "/v1/mcp/server/<id>/user-env-vars".
   * @param {string} key - LiteLLM-ключ.
   * @param {object} [body] - тело запроса (JSON).
   * @returns {Promise<{body?: unknown, status?: number, error?: string}>} ответ либо ошибка.
   */
  const gatewaySend = async (method, path, key, body) => {
    const base = gatewayBase()
    if (base === '') return { error: 'gatewayBaseUrl is not configured' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(cfg.modelDiscoveryTimeoutMs) || 20000)
    try {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: 'Bearer ' + key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        return { status: response.status, error: method + ' ' + path + ' -> HTTP ' + response.status
          + (' ' + sanitizeUpstream(text.trim()).slice(0, 300)) }
      }
      try {
        return { status: response.status, body: JSON.parse(text) }
      } catch {
        return { status: response.status, body: undefined }
      }
    } catch (error) {
      return { error: method + ' ' + path + ' failed: ' + messageOf(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Реестр серверов, доступных ключу. Живая проверка: GET /v1/mcp/server виртуальным ключом отдаёт
   * ТОЛЬКО разрешённые ключу серверы (без master-key), поля env_vars/static_headers при этом null.
   * Дубликаты server_name не «last-wins»: группы объединяются, факт пишется в диагностику (ревью F8).
   * @param {string} key - LiteLLM-ключ активного токена.
   * @returns {Promise<{servers?: object[], duplicates?: string[], error?: string}>} список либо ошибка.
   */
  const discoverRegistry = async (key) => {
    const answer = await gatewayGet('/v1/mcp/server', key)
    if (answer.error !== undefined) return { error: answer.error }
    const body = answer.body
    const list = Array.isArray(body) ? body : (Array.isArray(body && body.servers) ? body.servers : [])
    const byName = new Map()
    const duplicates = []
    for (const entry of list) {
      const serverName = typeof entry.server_name === 'string' && entry.server_name !== '' ? entry.server_name : ''
      if (serverName === '') continue
      const groups = Array.isArray(entry.mcp_access_groups) ? entry.mcp_access_groups : []
      const previous = byName.get(serverName)
      if (previous !== undefined) {
        duplicates.push(serverName)
        previous.accessGroups = [...new Set([...previous.accessGroups, ...groups])]
        if (previous.description === '' && typeof entry.description === 'string') previous.description = entry.description
        continue
      }
      byName.set(serverName, {
        name: serverName,
        serverId: typeof entry.server_id === 'string' ? entry.server_id : '',
        alias: typeof entry.alias === 'string' ? entry.alias : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        accessGroups: groups,
        transport: typeof entry.transport === 'string' ? entry.transport : '',
        // Требования сервер объявляет сам: шлюз отдаёт их полями записи, без конфига плагина.
        authType: typeof entry.auth_type === 'string' ? entry.auth_type : '',
        isByok: entry.is_byok === true,
        byokDescription: Array.isArray(entry.byok_description) ? entry.byok_description.filter((item) => typeof item === 'string') : [],
        byokHelpUrl: typeof entry.byok_api_key_help_url === 'string' ? entry.byok_api_key_help_url : '',
        hasUserCredential: entry.has_user_credential === true,
        // Имена заголовков, которые шлюз объявляет как клиентские (обычно пусто: admin-only поле).
        extraHeaders: Array.isArray(entry.extra_headers) ? entry.extra_headers.filter((item) => typeof item === 'string' && item !== '') : [],
        allowedToolsCount: Array.isArray(entry.allowed_tools) ? entry.allowed_tools.length : 0,
      })
    }
    if (duplicates.length > 0) {
      journal('WARN duplicate server_name in gateway registry: ' + [...new Set(duplicates)].join(',') + ' (merged)')
    }
    return { servers: [...byName.values()], duplicates: [...new Set(duplicates)] }
  }

  /**
   * Абсолютизировать setup_url шлюза (v1.100.1 отдаёт относительный '/ui/?page=mcp-servers&...').
   * @param {unknown} raw - значение из ответа шлюза.
   * @returns {string} полная http(s)-ссылка либо ''.
   */
  function absoluteSetupUrl(raw) {
    if (typeof raw !== 'string' || raw === '') return ''
    if (/^https?:\/\//i.test(raw)) return raw
    const base = gatewayBase()
    if (base === '') return ''
    return raw.startsWith('/') ? base + raw : base + '/' + raw
  }

  /**
   * Статус серверных кредов, которые живут в шлюзе (gateway-режим, FR-013b).
   * @param {string} key - LiteLLM-ключ активного токена.
   * @returns {Promise<{byServer?: Map<string, object>, error?: string}>} карта статусов либо ошибка.
   */
  const discoverEnvStatus = async (key) => {
    const answer = await gatewayGet('/v1/mcp/user-env-vars/status', key)
    if (answer.error !== undefined) return { error: answer.error }
    const body = answer.body
    const list = Array.isArray(body) ? body : (Array.isArray(body && body.servers) ? body.servers : [])
    const byServer = new Map()
    for (const entry of list) {
      const serverName = typeof entry.server_name === 'string' ? entry.server_name : ''
      if (serverName === '') continue
      const required = (Array.isArray(entry.required) ? entry.required : []).map((item) => ({
        name: typeof item.name === 'string' ? item.name : '',
        description: typeof item.description === 'string' ? item.description : '',
        isSet: item.is_set === true,
      }))
      byServer.set(serverName, {
        serverId: typeof entry.server_id === 'string' ? entry.server_id : '',
        alias: typeof entry.alias === 'string' ? entry.alias : '',
        required,
        missingCount: Number(entry.missing_count) || 0,
        setupUrl: absoluteSetupUrl(entry.setup_url),
      })
    }
    return { byServer }
  }

  /**
   * Конфиг сервера для плагина: из конфига, иначе синтезированный из записи реестра.
   * @param {string} serverName - имя сервера в шлюзе.
   * @returns {object|undefined} нормализованный сервер либо undefined (неизвестен).
   */
  const resolveServer = (serverName) => {
    const configured = catalog.servers.get(serverName)
    if (configured !== undefined) return configured
    if (state.registry.has(serverName)) {
      if (!state.runtime.has(serverName)) {
        state.runtime.set(serverName, {
          name: serverName,
          label: '',
          serverName,
          tokenHeader: '',
          tokenHeaderPrefix: '',
          tokenRef: '',
          tokenRequired: false,
          verifyTool: '',
          toolAllow: [],
          toolCallTimeoutMs: 180000,
          reconnectMaxAttempts: 60,
          synthesized: true,
        })
      }
      return state.runtime.get(serverName)
    }
    return undefined
  }

  /**
   * Заголовки запроса к MCP за шлюзом: права несёт ключ токена (FR-001), личный серверный токен —
   * только в header-режиме (FR-013a/FR-007).
   * @param {object} server - нормализованный сервер.
   * @param {string} litellmKey - ключ активного токена.
   * @param {string} personalToken - личный серверный токен ('' — нет).
   * @param {Record<string, string>} [extraHeaders] - заголовки, которые требует сам сервис.
   * @returns {Record<string, string>} заголовки.
   */
  const buildHeaders = (server, litellmKey, personalToken, extraHeaders) => {
    const headers = { Authorization: 'Bearer ' + litellmKey }
    for (const [name, value] of Object.entries(extraHeaders || {})) headers[name] = value
    if (server.tokenHeader !== '' && personalToken !== '') {
      headers[server.tokenHeader] = (server.tokenHeaderPrefix || '') + personalToken
    }
    return headers
  }

  /**
   * Собрать config dsh-mcp-client для сервера за шлюзом (всегда streamable-http).
   * @param {object} server - нормализованный сервер.
   * @param {string} litellmKey - ключ активного токена.
   * @param {string} personalToken - личный серверный токен ('' — нет).
   * @param {Record<string, string>} [extraHeaders] - заголовки, которые требует сам сервис.
   * @returns {object} конфиг для McpClient.Config().
   */
  const buildMcpConfig = (server, litellmKey, personalToken, extraHeaders) => ({
    serverName: server.serverName,
    transport: 'streamable-http',
    url: gatewayBase() + '/' + server.name + '/mcp',
    headers: buildHeaders(server, litellmKey, personalToken, extraHeaders),
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: false,
    reconnect: {
      enabled: true,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      maxAttempts: server.reconnectMaxAttempts,
    },
  })

  /**
   * Снять сервер: dispose fiber снимает его тулзы с реестра.
   * @param {string} serverName - имя сервера в шлюзе.
   */
  const unmount = async (serverName) => {
    const mount = state.mounts.get(serverName)
    if (mount && mount.fiber !== undefined) {
      try {
        await mount.fiber.dispose()
      } catch (error) {
        log('warn', 'dispose ' + serverName + ': ' + messageOf(error))
      }
    }
    state.mounts.delete(serverName)
  }

  /** Снять все монтирования (фаза A двухфазного применения). */
  const unmountAll = async () => {
    const names = [...state.mounts.keys()].filter((serverName) => {
      const record = state.mounts.get(serverName)
      return record !== undefined && record.fiber !== undefined
    })
    for (const serverName of names) await unmount(serverName)
    if (names.length > 0) journal('unmount all (' + names.join(',') + ')')
  }

  /** Имена mcp-тулзов, зарегистрированных сервером (семантический признак «смонтирован»). */
  const registeredTools = (serverName) => {
    let schemas = []
    try {
      schemas = ctx.tools.schemas()
    } catch (error) {
      log('warn', 'ctx.tools.schemas() отказал: ' + messageOf(error))
      return []
    }
    const prefix = 'mcp__' + serverName + '__'
    return schemas.map((schema) => schema.name).filter((toolName) => typeof toolName === 'string' && toolName.startsWith(prefix))
  }

  /**
   * Честная фаза: 'starting', пока хоть один сервер ещё монтируется, иначе 'ready' (или 'degraded'
   * при ошибке реестра/ключа). Иначе состояние рапортовало 'ready' в окне, когда тулз ещё нет.
   */
  const settlePhase = () => {
    if (state.barrier) return
    const starting = [...state.mounts.values()].some((record) => record.status === 'starting')
    // отвергнутый заголовочный токен — такая же деградация, как битый ключ (token-error)
    const tokenError = state.tokenRejected.size > 0 ? 'token-error: токен не принят (' + [...state.tokenRejected].join(',') + ')' : ''
    const next = (state.lastError !== '' || tokenError !== '') ? 'degraded' : (starting ? 'starting' : 'ready')
    if (next === state.phase) return
    const previous = state.phase
    state.phase = next
    if (next === 'degraded') {
      journal('phase ' + previous + ' -> degraded (' + (state.lastError !== '' ? state.lastError : tokenError) + ')')
    } else if (next === 'ready') {
      journal('ready token=' + state.activeToken + ' mounts='
        + [...state.mounts.values()].filter((record) => record.status === 'mounted').length)
    } else if (next === 'starting') {
      journal('phase ' + previous + ' -> starting (монтирования продолжаются)')
    }
  }

  /**
   * Монтировать сервер и дождаться активации, не полагаясь на числовой fiber.state (ревью F11):
   * семантический статус определяется наличием зарегистрированных тулзов сервера.
   * @param {object} server - нормализованный сервер.
   * @param {string} litellmKey - ключ активного токена.
   * @param {string} personalToken - личный серверный токен ('' — нет).
   * @param {Record<string, string>} [extraHeaders] - заголовки, которые требует сам сервис.
   */
  /** Сколько ждать активации фибера, прежде чем считать попытку неудачной. */
  const mountTimeoutMs = Math.max(1000, Number(cfg.mountTimeoutMs) || 8000)

  const mount = (server, litellmKey, personalToken, extraHeaders) => {
    const validated = McpClient.Config(buildMcpConfig(server, litellmKey, personalToken, extraHeaders))
    const fiber = ctx.plugin(McpClient, validated)
    const record = {
      name: server.name,
      status: 'starting',
      serverName: server.serverName,
      tokenRef: server.tokenRef,
      fiber,
      mountedAt: Date.now(),
      error: '',
      url: gatewayBase() + '/' + server.name + '/mcp',
      fiberState: fiber.state,
      setupUrl: '',
    }
    state.mounts.set(server.name, record)
    journal('mount ' + server.name + ' serverName=' + server.serverName
      + ' url=' + record.url
      + ' auth=bearer(litellm-key)'
      + (server.tokenHeader !== '' && personalToken !== '' ? ' +' + server.tokenHeader + '(len=' + personalToken.length + ')' : '')
      + (Object.keys(extraHeaders || {}).length > 0 ? ' +headers(' + Object.keys(extraHeaders).join(',') + ')' : ''))
    /**
     * Неудача попытки: сервис за шлюзом часто поднимается вместе с записью значения, поэтому
     * пробуем ещё, а не оставляем «ошибка» навсегда (раньше статус писался один раз).
     * @param {string} reason - почему попытка не удалась.
     */
    const failMount = (reason) => {
      record.attempts = (record.attempts || 0) + 1
      const limit = Math.max(1, Number(cfg.mountRetryAttempts) || 3)
      if (record.attempts >= limit) {
        record.status = 'failed'
        record.error = reason + ' (попыток: ' + record.attempts + ')'
        state.lastError = 'mount ' + server.name + ': ' + record.error
        journal('ERROR mount ' + server.name + ': ' + record.error)
        settlePhase()
        return
      }
      const delay = 1000 * record.attempts + 500
      journal('retry mount ' + server.name + ' через ' + delay + ' мс (' + reason + ')')
      record.status = 'starting'
      record.error = reason
      const timer = setTimeout(() => {
        // Пока ждали, сервер мог подняться сам (tools/change пересчитал статус) — тогда не
        // монтируем второй фибер поверх живого: старый остался бы без учёта.
        if (state.mounts.get(server.name) !== record) return
        if (record.status !== 'starting') return
        mount(server, litellmKey, personalToken, extraHeaders)
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
    }
    // Страховка от вечного «подключается…»: если активация не села за mountTimeoutMs, повторяем.
    const stallTimer = setTimeout(() => {
      if (record.status === 'starting' && state.mounts.get(server.name) === record) {
        failMount('активация не завершилась за ' + mountTimeoutMs + ' мс')
      }
    }, mountTimeoutMs)
    if (typeof stallTimer.unref === 'function') stallTimer.unref()
    Promise.resolve(fiber.inertia).then(() => {
      record.fiberState = fiber.state
      const tools = registeredTools(server.serverName)
      if (tools.length > 0) {
        record.status = 'mounted'
        journal('mount ' + server.name + ' -> mounted (' + tools.length + ' tools)')
        // прошлая проверка токена была отвергнута: не рапортуем зелёный статус до новой проверки
        if (state.tokenRejected.has(server.name)) {
          record.status = 'token-rejected'
          record.error = 'токен не принят (ждём повторной проверки)'
        }
        // проверка живости личного токена (verifyTool): результат асинхронный, статус сервера уточняется
        verifyOnMount(server)
        settlePhase()
        return
      }
      failMount('сервер активировался без тулзов (fiber.state=' + String(fiber.state) + ')')
    }).catch((error) => {
      failMount(messageOf(error))
    })
  }

  /**
   * Записать «не смонтирован по причине» (нет токена / нет env в шлюзе / ключ не работает).
   * @param {object} server - нормализованный сервер.
   * @param {string} status - 'no-token' | 'no-env' | 'key-error'.
   * @param {string} reason - причина без секретов.
   * @param {string} [setupUrl] - ссылка на простановку значения (gateway-режим).
   */
  const markSkipped = (server, status, reason, setupUrl) => {
    state.mounts.set(server.name, {
      name: server.name,
      status,
      serverName: server.serverName,
      tokenRef: server.tokenRef,
      fiber: undefined,
      mountedAt: 0,
      error: reason,
      url: gatewayBase() + '/' + server.name + '/mcp',
      fiberState: undefined,
      setupUrl: setupUrl || '',
    })
    journal('skip ' + server.name + ' (' + status + ': ' + reason + ')')
  }

  /* ───────────── проверка живости заголовочного токена (verifyTool) ───────────── */

  /** Признаки отказа по авторизации в тексте ошибки MCP (401/403 от MCP-сервера за шлюзом). */
  const VERIFY_REJECT_PATTERN = /unauthor|forbidden|authentic|access denied|invalid token|401|403/i

  /**
   * Разобрать тело ответа MCP: streamable-http отдаёт либо JSON, либо text/event-stream.
   * @param {Response} response - ответ fetch.
   * @returns {Promise<object|undefined>} разобранный JSON-RPC объект.
   */
  const readMcpBody = async (response) => {
    const contentType = String(response.headers.get('content-type') || '')
    const text = await response.text()
    if (contentType.includes('text/event-stream')) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        try {
          return JSON.parse(payload)
        } catch {
          /* следующая строка */
        }
      }
      return undefined
    }
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  /**
   * Текст, который вернул тулз MCP (result.content[].text, склеенный).
   * @param {object|undefined} body - JSON-RPC ответ.
   * @returns {string} текст ответа.
   */
  const mcpResultText = (body) => {
    const content = body && body.result && Array.isArray(body.result.content) ? body.result.content : []
    return content.filter((item) => item !== null && typeof item === 'object' && typeof item.text === 'string')
      .map((item) => item.text).join(String.fromCharCode(10))
  }

  /** Поля ответа, из которых берём идентификатор пользователя (логин/почта/id — не секрет). */
  const VERIFY_ID_KEYS = ['login', 'username', 'user', 'name', 'full_name', 'firstname', 'first_name', 'email', 'id']

  /**
   * Найти идентификатор пользователя в разобранном JSON (рекурсивно, до 3 уровней).
   * @param {unknown} node - узел.
   * @param {number} depth - глубина.
   * @returns {string} строка вида "login=ivan" либо ''.
   */
  const findIdentifier = (node, depth) => {
    if (depth > 3 || node === null || typeof node !== 'object') return ''
    for (const key of VERIFY_ID_KEYS) {
      const value = node[key]
      if (typeof value === 'string' && value !== '' && value.length <= 80) return key + '=' + value
      if (typeof value === 'number' && Number.isFinite(value)) return key + '=' + String(value)
    }
    for (const value of Object.values(node)) {
      const nested = findIdentifier(value, depth + 1)
      if (nested !== '') return nested
    }
    return ''
  }

  /** Поля-идентификаторы в текстовом ответе (`login: ivan`), в порядке приоритета. */
  const VERIFY_TEXT_ID_KEYS = ['login', 'email', 'pdm_user_id', 'user_id', 'username', 'name']

  /**
   * Идентификатор из ответа verifyTool: JSON-поле (login и т.п.), затем строки вида `login: ...`,
   * затем первая содержательная строка. Значение ограничено 80 символами.
   * @param {string} text - текст ответа.
   * @returns {string} идентификатор ('' — не нашли).
   */
  const identifierOf = (text) => {
    const trimmed = String(text || '').trim()
    if (trimmed === '') return ''
    try {
      const found = findIdentifier(JSON.parse(trimmed), 0)
      if (found !== '') return found.slice(0, 80)
    } catch {
      /* не JSON — разбираем строки */
    }
    const lines = trimmed.split(/\r?\n/)
    for (const key of VERIFY_TEXT_ID_KEYS) {
      for (const line of lines) {
        const match = new RegExp('^\\s*' + key + '\\s*:\\s*(.+?)\\s*$').exec(line)
        if (match !== null && match[1] !== '') return match[1].slice(0, 80)
      }
    }
    for (const line of lines) {
      const value = line.trim()
      // строка-обёртка вида <...> — не идентификатор
      if (value === '' || (value.startsWith('<') && value.endsWith('>'))) continue
      return value.slice(0, 80)
    }
    return ''
  }

  /**
   * Логический код ответа тулза: MCP нередко отдаёт 401/403 внутри успешного HTTP-ответа
   * (result.content[].text c `status_code: 401`). HTTP-код тут не поможет.
   * @param {object|undefined} body - JSON-RPC ответ.
   * @param {string} text - текст результата.
   * @returns {{code: number, error: string}} код (0 — не нашли) и `error: ...` из ответа.
   */
  const statusOfResult = (body, text) => {
    const result = body && body.result ? body.result : undefined
    let code = 0
    let error = ''
    if (result !== undefined && result.structuredContent !== undefined && typeof result.structuredContent === 'object'
      && result.structuredContent !== null && typeof result.structuredContent.status_code === 'number') {
      code = result.structuredContent.status_code
    }
    const codeMatch = /(^|\n)\s*status_code\s*:\s*(\d{3})\s*(\n|$)/.exec(text)
    if (code === 0 && codeMatch !== null) code = Number(codeMatch[2])
    const errorMatch = /(^|\n)\s*error\s*:\s*([^\n]*)/.exec(text)
    if (errorMatch !== null) error = errorMatch[2].trim().replace(/^['"]|['"]$/g, '')
    return { code, error }
  }

  /**
   * Вызвать verifyTool по MCP streamable-http теми же заголовками, что и монтирование.
   * Возвращает статус по HTTP-коду и телу: 401/403 (и тексты про авторизацию) — rejected,
   * сеть/таймаут/прочие коды — unknown, успешный tools/call — ok.
   * @param {object} server - нормализованный сервер (нужны name и verifyTool).
   * @param {Record<string, string>} headers - заголовки (bearer ключа + личный токен).
   * @param {number} timeoutMs - таймаут всей проверки.
   * @returns {Promise<{status: string, httpCode: number, reason: string, text: string}>} результат.
   */
  const callVerifyTool = async (server, headers, timeoutMs) => {
    const url = gatewayBase() + '/' + server.name + '/mcp'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) > 0 ? Number(timeoutMs) : 10000)
    const baseHeaders = Object.assign({}, headers, {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    })
    const post = async (payload, sessionId) => {
      const requestHeaders = Object.assign({}, baseHeaders)
      if (sessionId !== '') requestHeaders['mcp-session-id'] = sessionId
      return fetch(url, {
        method: 'POST', headers: requestHeaders, body: JSON.stringify(payload), signal: controller.signal,
      })
    }
    try {
      const init = await post({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-mcp-access-verify', version: '1' } },
      }, '')
      if (init.status === 401 || init.status === 403) {
        return { status: 'rejected', httpCode: init.status, reason: 'MCP initialize -> HTTP ' + init.status, text: '' }
      }
      if (!init.ok) return { status: 'unknown', httpCode: init.status, reason: 'MCP initialize -> HTTP ' + init.status, text: '' }
      await readMcpBody(init)
      const sessionId = String(init.headers.get('mcp-session-id') || '')
      try {
        await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
      } catch {
        /* уведомление необязательно */
      }
      const call = await post({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: String(server.verifyTool || ''), arguments: {} },
      }, sessionId)
      const code = call.status
      const body = await readMcpBody(call)
      if (code === 401 || code === 403) {
        return { status: 'rejected', httpCode: code, reason: 'tools/call -> HTTP ' + code, text: '' }
      }
      if (!call.ok) return { status: 'unknown', httpCode: code, reason: 'tools/call -> HTTP ' + code, text: '' }
      if (body !== undefined && body.error !== undefined) {
        const message = String((body.error && (body.error.message || body.error.code)) || '')
        return {
          status: VERIFY_REJECT_PATTERN.test(message) ? 'rejected' : 'unknown',
          httpCode: code,
          reason: 'MCP error: ' + sanitizeUpstream(message).slice(0, 160),
          text: '',
        }
      }
      const text = mcpResultText(body)
      const logical = statusOfResult(body, text)
      const reasonBase = sanitizeUpstream(logical.error !== '' ? 'status_code ' + logical.code + ', error=' + logical.error : 'status_code ' + logical.code)
      if (logical.code === 401 || logical.code === 403) {
        return { status: 'rejected', httpCode: logical.code, reason: reasonBase, text: '' }
      }
      const isError = body !== undefined && body.result !== undefined && body.result.isError === true
      if (isError) {
        return {
          status: VERIFY_REJECT_PATTERN.test(text) ? 'rejected' : 'unknown',
          httpCode: logical.code !== 0 ? logical.code : code,
          reason: logical.code !== 0 ? reasonBase : 'MCP result isError: ' + sanitizeUpstream(text.trim()).slice(0, 160),
          text: '',
        }
      }
      if (logical.code !== 0 && logical.code !== 200) {
        return { status: 'unknown', httpCode: logical.code, reason: reasonBase, text: '' }
      }
      return { status: 'ok', httpCode: logical.code !== 0 ? logical.code : code, reason: '', text }
    } catch (error) {
      return { status: 'unknown', httpCode: 0, reason: sanitizeUpstream(messageOf(error)), text: '' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Тулз-проба для проверки личного значения: verifyTool из конфига, иначе первый *whoami*
   * сервера. Автовыбор нужен, чтобы не требовать от конфига имени пробы: whoami дёшев и на
   * негодном значении отвечает 401/403.
   * @param {object} server - нормализованный сервер.
   * @returns {string} raw-имя тулза для tools/call ('' — пробы нет).
   */
  const verifyToolOf = (server) => {
    if (String(server.verifyTool || '') !== '') return String(server.verifyTool)
    const prefix = 'mcp__' + server.serverName + '__'
    const probe = registeredTools(server.serverName).find((name) => /whoami/i.test(name))
    if (probe === undefined) return ''
    return String(probe).slice(prefix.length)
  }

  /**
   * Пересчитать статусы монтирования по факту зарегистрированных тулзов: фибер может подключиться
   * позже первой попытки (reconnect, failOnStartupError:false), и тогда «ошибка» на экране врёт, а
   * личное значение так и остаётся непроверенным.
   */
  const recalcMounts = () => {
    let changed = false
    for (const record of state.mounts.values()) {
      if (record.fiber === undefined) continue
      const tools = registeredTools(record.serverName)
      if (tools.length > 0 && record.status !== 'mounted' && record.status !== 'token-rejected') {
        record.status = 'mounted'
        record.error = ''
        changed = true
        journal('mount ' + record.name + ' -> mounted (' + tools.length + ' tools, по tools/change)')
        const server = resolveServer(record.name)
        if (server !== undefined) verifyOnMount(server)
        continue
      }
      if (tools.length === 0 && record.status === 'mounted') {
        record.status = 'starting'
        changed = true
        journal('mount ' + record.name + ' -> starting (тулзы исчезли)')
      }
    }
    if (changed) settlePhase()
  }

  /**
   * Проверить живость личного токена сервера через verifyTool и запомнить результат.
   * Кеш — по отпечатку значения токена (значение не хранится, только sha256-префикс).
   * @param {object} server - нормализованный сервер.
   * @param {{force?: boolean}} [options] - force: игнорировать кеш (ручная ручка).
   * @returns {Promise<object>} запись проверки (status = token-ok|token-rejected|token-unknown).
   */
  /**
   * Текущая эпоха вердикта сервера (растёт при каждой записи значения).
   * @param {string} serverName - имя сервера.
   * @returns {number} эпоха.
   */
  const verifyEpochOf = (serverName) => Number(state.verifyEpoch.get(serverName) || 0)

  /**
   * Снять запрет тулзов, поставленный отвергнутым значением, и пересчитать фазу.
   * @param {string} serverName - имя сервера.
   */
  const clearRejection = (serverName) => {
    if (!state.tokenRejected.delete(serverName)) return
    applyAgentGates()
    settlePhase()
  }

  /**
   * Сбросить вердикт проверки: значение заменено или снято, ответ относится к другому значению.
   * Эпоха растёт, чтобы проверка, начатая ДО записи, не воскресила запрет тулзов после неё.
   * @param {string} serverName - имя сервера.
   */
  const invalidateVerify = (serverName) => {
    state.verify.delete(serverName)
    state.verifyEpoch.set(serverName, verifyEpochOf(serverName) + 1)
    if (state.tokenRejected.delete(serverName)) {
      applyAgentGates()
      settlePhase()
    }
  }

  const verifyServer = async (server, options) => {
    const force = options !== undefined && options.force === true
    const checkedAt = Date.now()
    // Эпоха берётся до чтения секретов: если значение поменяют, пока идёт проверка, вердикт
    // относится к прошлому значению и должен быть отброшен, а не записан.
    const epoch = verifyEpochOf(server.name)
    const headerMode = server.tokenHeader !== ''
    const token = activeGrant()
    const key = token !== undefined && token.keyRef !== '' ? await readSecret(token.keyRef) : ''
    const personal = headerMode ? await readSecret(server.tokenRef) : ''
    const rawHeaders = await readServerHeaders(server.name)
    const storedHeaders = rawHeaders === undefined || rawHeaders === null ? {} : rawHeaders
    // Личное значение живёт в трёх местах: credential-store плагина (header-режим), его же
    // хранилище заголовков (client-headers) и шлюз (env var сервера). Проверять есть что, если
    // объявлен verifyTool и заполнено хотя бы одно из них.
    const envRecord = state.envStatus.get(server.name)
    const envMode = !headerMode && envRecord !== undefined
    const probeTool = verifyToolOf(server)
    if (probeTool === '') {
      const record = { server: server.name, status: 'token-unknown', httpCode: 0, reason: 'нет тулза-пробы (verifyTool или *whoami)', login: '', checkedAt, tokenRef: server.tokenRef, fingerprint: '' }
      state.verify.set(server.name, record)
      journal('verify ' + server.name + ' token-unknown reason=no probe tool')
      clearRejection(server.name)
      return record
    }
    if (!headerMode && !envMode && Object.keys(storedHeaders).length === 0) {
      clearRejection(server.name)
      return { server: server.name, status: 'token-unknown', httpCode: 0, reason: 'сервер не требует личных значений — проверять нечего', login: '', checkedAt, tokenRef: server.tokenRef }
    }
    // Значение не хранится: отпечаток — sha256 от материала проверки. Он меняется вместе с
    // ключом, личным токеном, заголовками и заполненностью env var в шлюзе, поэтому кеш честный.
    const material = [key, personal, JSON.stringify(storedHeaders),
      envMode ? String(envRecord.missingCount) : 'no-env', String(envMode)].join('\u0000')
    const fingerprint = createHash('sha256').update(material).digest('hex').slice(0, HASH_LENGTH)
    const previous = state.verify.get(server.name)
    const ttlMs = Number(cfg.verifyTtlMs) > 0 ? Number(cfg.verifyTtlMs) : 300000
    if (!force && previous !== undefined && previous.fingerprint === fingerprint
      && checkedAt - previous.checkedAt < ttlMs) {
      return previous
    }
    if (headerMode && personal === '') {
      const record = { server: server.name, status: 'token-unknown', httpCode: 0, reason: 'token not set in credential store (' + server.tokenRef + ')', login: '', checkedAt, tokenRef: server.tokenRef, fingerprint }
      state.verify.set(server.name, record)
      journal('verify ' + server.name + ' token-unknown reason=token not set')
      clearRejection(server.name)
      return record
    }
    const probeTarget = Object.assign({}, server, { verifyTool: probeTool })
    const result = await callVerifyTool(probeTarget, buildHeaders(server, key, personal, storedHeaders), cfg.verifyTimeoutMs)
    if (verifyEpochOf(server.name) !== epoch) {
      journal('verify ' + server.name + ' discarded: значение изменилось во время проверки')
      return { server: server.name, status: 'token-unknown', httpCode: 0, reason: 'значение изменилось во время проверки', login: '', checkedAt, tokenRef: server.tokenRef, fingerprint: '' }
    }
    const status = result.status === 'ok' ? 'token-ok' : (result.status === 'rejected' ? 'token-rejected' : 'token-unknown')
    const record = {
      server: server.name,
      status,
      httpCode: result.httpCode,
      reason: result.reason,
      login: result.status === 'ok' ? identifierOf(result.text) : '',
      checkedAt,
      tokenRef: server.tokenRef,
      fingerprint,
    }
    state.verify.set(server.name, record)
    const wasRejected = state.tokenRejected.has(server.name)
    if (status === 'token-rejected') state.tokenRejected.add(server.name)
    else state.tokenRejected.delete(server.name)
    const mountRecord = state.mounts.get(server.name)
    if (mountRecord !== undefined) {
      mountRecord.tokenStatus = status
      mountRecord.tokenReason = record.reason
      if (status === 'token-rejected') {
        mountRecord.status = 'token-rejected'
        mountRecord.error = 'токен не принят: ' + (record.reason !== '' ? record.reason : 'HTTP ' + record.httpCode)
      } else if (mountRecord.status === 'token-rejected') {
        mountRecord.status = mountRecord.fiber !== undefined ? 'mounted' : 'not-mounted'
        mountRecord.error = ''
      }
    }
    journal('verify ' + server.name + ' ' + status + ' httpCode=' + String(record.httpCode)
      + (record.login !== '' ? ' id=' + record.login : '')
      + (record.reason !== '' ? ' reason=' + record.reason : ''))
    if (wasRejected !== state.tokenRejected.has(server.name)) {
      applyAgentGates()
      settlePhase()
    }
    return record
  }

  /**
   * Автопроверка после монтирования (кешируется; не блокирует применение).
   * @param {object} server - нормализованный сервер.
   */
  const verifyOnMount = (server) => {
    if (verifyToolOf(server) === '') return
    verifyServer(server, { force: false }).catch((error) => {
      log('warn', 'verify ' + server.name + ': ' + messageOf(error))
      journal('ERROR verify ' + server.name + ': ' + messageOf(error))
    })
  }

  /**
   * Проверить сервер сразу после записи личного значения (env var) — без кеша:
   * иначе экран показывал бы «подключён» для значения, которое сервис не принимает.
   * @param {string} name - имя сервера.
   */
  const verifyNow = async (name) => {
    const server = resolveServer(name)
    if (server === undefined) return
    // Проба — это тулз сервера, поэтому до монтирования проверять нечем: вердикт даст
    // verifyOnMount сразу после появления тулзов (иначе «Проверить» молча ничего не делала).
    if (verifyToolOf(server) === '') {
      journal('verify ' + name + ' deferred: сервер ещё не смонтирован (вердикт будет после монтирования)')
      return
    }
    try {
      await verifyServer(server, { force: true })
    } catch (error) {
      log('warn', 'verify ' + name + ': ' + messageOf(error))
      journal('ERROR verify ' + name + ': ' + messageOf(error))
    }
  }

  /**
   * Фаза B: посчитать НОВЫЕ гранты/монтирования (локально, без публикации в state) и смонтировать.
   * Гранты и managedNames публикуются только коммитом в applyNow (ревью P1-3).
   * @param {string} reason - метка для журнала.
   * @returns {Promise<{grants: Map<string, object>, managedNames: Set<string>, ok: boolean}>} следующий набор.
   */
  const prepareMounts = async (reason, only) => {
    const token = activeGrant()
    const keyRef = token ? token.keyRef : ''
    const key = keyRef !== '' ? await readSecret(keyRef) : ''
    const grants = new Map()
    const managedNames = new Set()
    state.registryWarnings = []
    // Список серверов снимается ДО очистки реестра: иначе ветки «нет ключа» и «реестр упал»
    // итерируют уже пустой реестр и ни одна строка статуса не создаётся (servers: [] на экране).
    // Имена запоминаются: после «Отключить» реестр пуст, а строки с причиной должны остаться.
    const knownEntries = serverEntries()
    const knownNames = knownEntries.length > 0 ? knownEntries.map((server) => server.name) : [...state.lastServerNames]
    /**
     * Строка «не смонтирован по причине» для сервера, которого уже нет в реестре (после «Отключить»
     * реестр пуст): запись строится по одному имени, чтобы причина осталась видимой.
     * @param {string} serverName - имя сервера.
     * @param {string} status - 'no-active-token' | 'key-error' | 'no-env'. 
     * @param {string} reason - причина без секретов.
     */
    const skipKnown = (serverName, status, reason) => {
      const known = resolveServer(serverName)
      if (known !== undefined) return markSkipped(known, status, reason)
      return markSkipped({ name: serverName, label: serverName, serverName, tokenRef: '', tokenHeader: '', verifyTool: '' }, status, reason)
    }

    if (key === '') {
      state.registry = new Map()
      state.envStatus = new Map()
      state.registryAt = 0
      state.registryError = token === undefined
        ? 'no active token'
        : (keyRef === '' ? 'token "' + token.id + '" has no keyRef' : 'key of token "' + token.id + '" is not set (' + keyRef + ')')
      journal('registry skipped: ' + state.registryError)
      // ревью F5: причина видна и в состоянии/на странице, а не только в журнале.
      // Без активного токена это не «ошибка ключа», а «токен не выбран» — иначе экран врёт.
      // Точечное применение чужие записи не переписывает: иначе транзиентная ошибка реестра
      // пометила бы «ошибкой ключа» серверы, которые на самом деле живы.
      const skipStatus = token === undefined ? 'no-active-token' : 'key-error'
      for (const serverName of knownNames) skipKnown(serverName, skipStatus, state.registryError)
      return { grants, managedNames, ok: false }
    }

    const registry = await discoverRegistry(key)
    if (registry.error !== undefined) {
      // Ревью F7/P2-3: битый или отозванный ключ — НИЧЕГО не монтируем (было: старые mounted жили).
      state.registryError = registry.error
      state.envStatus = new Map()
      state.registry = new Map()
      state.registryWarnings = []
      journal('ERROR registry: ' + registry.error + ' — монтирования не выполняются')
      for (const serverName of knownNames) skipKnown(serverName, 'key-error', registry.error)
      return { grants, managedNames, ok: false }
    }
    state.registryError = ''
    state.registryAt = Date.now()
    state.registry = new Map(registry.servers.map((server) => [server.name, server]))
    // Запомнить состав: если дальше случится «Отключить» или реестр упадёт, строки не исчезнут.
    const composition = [...state.registry.keys()]
    if (composition.join('\u0000') !== state.lastServerNames.join('\u0000')) {
      state.lastServerNames = composition
      // Персист — фоном: состав меняется редко, а монтирования ждать записи файла незачем.
      saveStateDoc().catch((error) => journal('ERROR saveState(composition): ' + messageOf(error)))
    }
    state.registryWarnings = (registry.duplicates || []).map((serverName) => 'duplicate server_name "' + serverName + '" в реестре шлюза (записи объединены)')

    const envStatus = await discoverEnvStatus(key)
    if (envStatus.error !== undefined) {
      state.envStatusError = envStatus.error
    } else {
      state.envStatusError = ''
      state.envStatus = envStatus.byServer
    }
    // Статус env не обновился: карта осталась от прошлого токена, и решать по ней нельзя.
    // Серверы, у которых были требования, не монтируем (нужное значение не подтверждено шлюзом).
    if (state.envStatusError !== '') journal('WARN env status недоступен: ' + state.envStatusError + ' — серверы с требованиями не монтируются')

    // Проверка живости ключа перед монтированием (P2-3): GET /v1/models тем же ключом.
    const health = await discoverModels(key)
    state.keyHealthError = health.error !== undefined ? health.error : ''

    const grantedNames = token !== undefined && token.servers.size > 0
      ? [...token.servers.keys()]
      : [...state.registry.keys()]

    for (const serverName of grantedNames) {
      const server = resolveServer(serverName)
      if (server === undefined) {
        log('warn', 'грант указывает на неизвестный сервер "' + serverName + '" — пропущен')
        journal('ERROR unknown server ' + serverName)
        continue
      }
      if (!SERVER_NAME_PATTERN.test(server.serverName)) {
        journal('ERROR serverName ' + serverName + ' ' + server.serverName)
        continue
      }
      managedNames.add(server.serverName)
      const grant = token !== undefined ? token.servers.get(serverName) : undefined
      const toolAllow = grant !== undefined && grant.tools.length > 0 ? grant.tools : server.toolAllow
      grants.set(server.serverName, {
        name: serverName,
        serverName: server.serverName,
        all: toolAllow.length === 0,
        tools: new Set(toolAllow),
      })
      // Точечное применение (запись личного значения одного сервера): чужие монтирования и их
      // статусы не трогаем — перемонтируется только названный сервер.
      if (only !== undefined && !only.has(serverName)) continue

      // Ключ не подтвердился на /v1/models: реестр ответил, но модели — нет (ключ мог быть урезан).
      if (state.keyHealthError !== '') {
        markSkipped(server, 'key-error', 'ключ не подтвердился (GET /v1/models: ' + state.keyHealthError + ')')
        continue
      }
      const headerMode = server.tokenHeader !== '' && server.tokenRef !== ''
      const personal = headerMode ? await readSecret(server.tokenRef) : ''
      if (headerMode && server.tokenRequired && personal === '') {
        markSkipped(server, 'no-token', 'token not set in credential store (' + server.tokenRef + ')')
        continue
      }
      // Заголовки, которые сервис требует от клиента: имя приходит из записи шлюза (extra_headers
      // или описание), значение — из credential-store. Нет значения — сервер не монтируется.
      const serverHeaders = await readServerHeaders(server.name)
      const missingHeaders = requiredHeaderNames(server, state.registry.get(server.name))
        .filter((name) => typeof serverHeaders[name] !== 'string' || serverHeaders[name] === '')
      if (missingHeaders.length > 0) {
        markSkipped(server, 'no-header', 'сервис требует заголовки: ' + missingHeaders.join(', '))
        continue
      }
      if (state.envStatusError !== '' && state.envStatus.has(serverName)) {
        markSkipped(server, 'no-env', 'статус личных значений недоступен: ' + state.envStatusError)
        continue
      }
      const env = state.envStatus.get(serverName)
      if (env !== undefined && env.missingCount > 0) {
        const missing = env.required.filter((item) => !item.isSet).map((item) => item.name).join(', ')
        markSkipped(server, 'no-env', 'gateway env missing: ' + (missing || env.missingCount + ' var(s)'), env.setupUrl)
        continue
      }
      mount(server, key, personal, serverHeaders)
    }
    // Серверы, которых нет в реестре шлюза (описаны только в конфиге плагина), в цикле выше не участвуют:
    // если такому нужен личный ключ и его нет — это «нет личного ключа», а не «не подключён».
    for (const server of serverEntries()) {
      if (only !== undefined) break
      if (state.mounts.has(server.name)) continue
      const headerMode = server.tokenHeader !== '' && server.tokenRef !== ''
      if (!headerMode) continue
      const personal = await readSecret(server.tokenRef)
      if (personal === '') markSkipped(server, 'no-token', 'token not set in credential store (' + server.tokenRef + ')')
    }
    journal('prepare (' + reason + '): grant=' + grantedNames.length
      + ' starting=' + [...state.mounts.values()].filter((record) => record.status === 'starting').length
      + ' registry=' + state.registry.size)
    // Ключ или статус env не подтвердились: набор не считается рабочим, иначе фаза врёт «ready».
    return { grants, managedNames, ok: state.keyHealthError === '' && state.envStatusError === '' }
  }

  /* ─────────────────── M3: модели = права LiteLLM-ключа токена ─────────────────── */

  const modelGate = { installed: false, llm: null, base: null }

  const llmBaseUrl = () => String(cfg.llmBaseUrl || '').replace(/\/$/, '')

  /**
   * Ёмкости из описания моделей шлюза: GET {base}/model/info → litellm_params.
   * Источник второй (первый — /models), нужен потому, что /models отдаёт max_input_tokens не для всех
   * записей, а /model/info отдаёт их в litellm_params (у части моделей — только там).
   * Любая ошибка или неожиданный формат = пустая карта, discovery продолжается.
   * @param {string} base - база шлюза без завершающего слэша.
   * @param {string} key - LiteLLM-ключ.
   * @param {AbortSignal} signal - общий сигнал таймаута discovery.
   * @returns {Promise<Map<string, {contextWindow?: number, maxTokens?: number}>>}
   */
  const discoveryInfoLimits = async (base, key, signal) => {
    const limits = new Map()
    try {
      const response = await fetch(base + '/model/info', {
        headers: { authorization: 'Bearer ' + key },
        signal,
      })
      if (!response.ok) return limits
      const body = await response.json()
      const entries = Array.isArray(body && body.data) ? body.data : []
      for (const entry of entries) {
        const modelId = typeof entry.model_name === 'string' ? entry.model_name : ''
        if (modelId === '') continue
        const params = entry.litellm_params !== null && typeof entry.litellm_params === 'object'
          ? entry.litellm_params
          : {}
        const contextWindow = Number(params.max_input_tokens)
        const maxTokens = Number(params.max_output_tokens)
        const hasContext = Number.isFinite(contextWindow) && contextWindow > 0
        const hasOutput = Number.isFinite(maxTokens) && maxTokens > 0
        if (!hasContext && !hasOutput) continue
        limits.set(modelId, {
          ...(hasContext ? { contextWindow } : {}),
          ...(hasOutput ? { maxTokens } : {}),
        })
      }
    } catch {
      /* второй источник необязателен */
    }
    return limits
  }

  /**
   * Спросить у шлюза, что разрешено ключу: GET {base}/models.
   * @param {string} key - LiteLLM-ключ.
   * @returns {Promise<{ids?: string[], error?: string}>} список id моделей либо ошибка.
   */
  const discoverModels = async (key) => {
    const base = llmBaseUrl()
    if (base === '') return { error: 'llmBaseUrl is not configured' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(cfg.modelDiscoveryTimeoutMs) || 20000)
    try {
      const response = await fetch(base + '/models', {
        headers: { authorization: 'Bearer ' + key },
        signal: controller.signal,
      })
      if (!response.ok) return { error: 'GET /models -> HTTP ' + response.status }
      const body = await response.json()
      const entries = (Array.isArray(body && body.data) ? body.data : [])
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
      const ids = entries.map((entry) => entry.id)
      /**
       * Ёмкости, которые шлюз сообщает не для всех моделей (на 2026-10-27 — у 6 из 46).
       * Без них модель объявляется с дефолтами 131072/32768, и автокомпакт режет длинные
       * сессии раньше времени (у deepseek-v4-pro шлюз отдаёт 1000000/393216).
       */
      const limits = new Map()
      for (const entry of entries) {
        const contextWindow = Number(entry.max_input_tokens)
        const maxTokens = Number(entry.max_output_tokens)
        const hasContext = Number.isFinite(contextWindow) && contextWindow > 0
        const hasOutput = Number.isFinite(maxTokens) && maxTokens > 0
        if (!hasContext && !hasOutput) continue
        limits.set(entry.id, {
          ...(hasContext ? { contextWindow } : {}),
          ...(hasOutput ? { maxTokens } : {}),
        })
      }
      // Второй источник ёмкостей: /model/info (litellm_params.max_input_tokens/max_output_tokens).
      // В /models этих полей часто нет (например, у google/gemini-4-argon и anthropic/claude-opus-5.5),
      // а в описании записи — есть. Первый источник приоритетнее, ошибки второго не фатальны.
      const infoLimits = await discoveryInfoLimits(base, key, controller.signal)
      for (const [modelId, entry] of infoLimits) {
        if (!ids.includes(modelId)) continue
        limits.set(modelId, { ...entry, ...(limits.get(modelId) || {}) })
      }
      return { ids, limits }
    } catch (error) {
      return { error: 'GET /models failed: ' + messageOf(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Сузить каталог session/modelCatalog до ответа /v1/models ключа активного токена.
   * Каталог собирается на каждый RPC (dsh-api-session-controller/lib/index.js:563-608), поэтому
   * обёртка listModels провайдера — единственная точка фильтра.
   */
  const installModelGate = () => {
    if (modelGate.installed) return
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listModels !== 'function') {
      log('warn', 'ctx.llm недоступен — сужение каталога моделей не установлено')
      journal('ERROR no ctx.llm')
      return
    }
    const base = { listModels: llm.listModels }
    llm.listModels = async (providerId) => {
      const models = await base.listModels.call(llm, providerId)
      if (!modelState.known || providerId !== modelState.provider) return models
      return models.filter((model) => modelState.allowed.has(model.id))
    }
    modelGate.installed = true
    modelGate.llm = llm
    modelGate.base = base
    ctx.effect(() => () => {
      try {
        if (modelGate.base !== null) llm.listModels = modelGate.base.listModels
      } catch (error) {
        log('warn', 'restore ctx.llm.listModels: ' + messageOf(error))
      }
      modelGate.installed = false
    }, 'dsh-mcp-access.modelGate')
    journal('model catalog narrowing installed')
  }

  /**
   * Маршрут моделей, которым плагин владеет сам. llm-pi-ai отдаёт селектору только то, что
   * объявлено в cordis.patch.yml, и не даёт регистрировать модели в рантайме — поэтому свой
   * провайдер (createProvider + PiAiAdapter + registerAdapter) с живым `getModels()`: каталог
   * читается из modelState.allowed, то есть равен правам активного ключа и меняется вместе с ним.
   *
   * Провайдер с id llmProvider НЕ должен быть объявлен в патче профиля: два владельца одного
   * маршрута — конфликт регистрации (тогда пишем в журнал и остаёмся на чужих моделях).
   */
  const gatewayRoute = { installed: false, handle: null, providerId: '' }

  const installGatewayRoute = async () => {
    if (gatewayRoute.installed) return
    if (!modelSyncEnabled) {
      journal('models: own route not installed (modelSync disabled: нужен llmProvider/llmSecretRef/llmBaseUrl)')
      return
    }
    const providerId = String(cfg.llmProvider || '')
    if (providerId === '') {
      journal('models: own route not installed (llmProvider пуст)')
      return
    }
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.registerAdapter !== 'function') {
      log('warn', 'ctx.llm.registerAdapter недоступен — свой маршрут моделей не поднят')
      journal('ERROR no ctx.llm.registerAdapter')
      return
    }
    try {
      // pi-ai — ESM-only (exports "." без условия require), поэтому его резолвим сами.
      const piAi = await import(hostModuleUrl('@earendil-works/pi-ai'))
      const dshPi = await import(pathToFileURL(hostResolve('@deepseek-ai/dsh-llm-pi-ai')).href)
      const dshLlm = await import(pathToFileURL(hostResolve('@deepseek-ai/dsh-llm')).href)
      const route = buildGatewayRoute({
        piAi,
        loadApi: () => import(hostModuleUrl('@earendil-works/pi-ai', 'api/openai-completions')),
        dshPi,
        dshLlm,
        providerId,
        displayName: 'LiteLLM (ключ DSH)',
        baseUrl: llmBaseUrl(),
        defaultContextWindow: cfg.defaultContextWindow,
        defaultMaxTokens: cfg.defaultMaxTokens,
        reasoning: cfg.defaultReasoningEffort,
        /**
         * Ключ активного токена на один вызов (пустая строка — ключа нет).
         * @returns {Promise<string>} значение ключа из credential-store.
         */
        resolveKey: async () => {
          const token = catalog.tokens.get(state.activeToken)
          if (token === undefined || token.keyRef === '') return ''
          return await readSecret(token.keyRef)
        },
        /** @returns {object[]} каталог прав активного ключа вместе с ёмкостями шлюза. */
        modelCatalog: () => (modelState.known
          ? [...modelState.allowed].map((id) => ({ id, ...(modelState.limits.get(id) || {}) }))
          : []),
        resolveAttachments: () => {
          try {
            return ctx.get('attachments')
          } catch (error) {
            return undefined
          }
        },
        log,
      })
      gatewayRoute.handle = llm.registerAdapter([providerId], route.adapter)
      gatewayRoute.installed = true
      gatewayRoute.providerId = providerId
      ctx.effect(() => () => {
        try {
          if (gatewayRoute.handle !== null) gatewayRoute.handle()
        } catch (error) {
          log('warn', 'release llm route: ' + messageOf(error))
        }
        gatewayRoute.handle = null
        gatewayRoute.installed = false
        gatewayRoute.providerId = ''
      }, 'verme-gate.gatewayRoute')
      // Каталога на этом шаге ещё нет (discovery идёт ниже), поэтому размер не печатаем:
      // живой список = права ключа, их пишет строка «key of token … allows N model(s)».
      journal('models: own route "' + providerId + '" registered, api=openai-completions (каталог живой: getModels)')
    } catch (error) {
      const message = messageOf(error)
      log('warn', 'llm route "' + providerId + '": ' + message)
      journal('ERROR llm route "' + providerId + '": ' + message
        + ' (если провайдер объявлен в cordis.patch.yml — убери его оттуда: маршрутом владеет плагин)')
    }
  }

  /**
   * Подмена значения «модель по умолчанию» в памяти (когда saveSelection не может записать конфиг,
   * перекрытый home-патчем). Держим ОДИН disposer, чтобы не накапливать эффекты (ревью F11).
   */
  const defaultGuard = { installed: false, service: null, base: null, value: null }

  /** @param {{provider: string, model: string}|null} value - подставляемый выбор или null (снять подмену). */
  const installDefaultSubstitute = (value) => {
    const service = defaultGuard.service !== null ? defaultGuard.service : ctx.get('agentDefaultModel')
    if (service === undefined || service === null || typeof service.currentSelection !== 'function') return
    defaultGuard.service = service
    defaultGuard.value = value
    if (value === null) {
      if (defaultGuard.installed) {
        try {
          Object.defineProperty(service, 'currentSelection', {
            value: defaultGuard.base, configurable: true, writable: true, enumerable: false,
          })
        } catch (error) {
          log('warn', 'restore currentSelection: ' + messageOf(error))
        }
        defaultGuard.installed = false
        journal('default model substitution lifted')
      }
      return
    }
    if (defaultGuard.installed) return
    defaultGuard.base = service.currentSelection
    Object.defineProperty(service, 'currentSelection', {
      value: () => ({ provider: defaultGuard.value.provider, model: defaultGuard.value.model }),
      configurable: true, writable: true, enumerable: false,
    })
    defaultGuard.installed = true
    journal('default model substituted in memory: ' + value.provider + '/' + value.model)
  }

  /**
   * Переставить модель у живых агентов, если их выбор вне прав нового ключа.
   * @param {string} provider - провайдер активного токена.
   * @param {string} model - доступная модель.
   * @returns {number} сколько агентов переставлено.
   */
  const reselectLiveAgents = (provider, model) => {
    const controller = ctx.get('sessionController')
    const agents = controller ? controller.agents : undefined
    if (agents === undefined || typeof agents.selectForNextRequest !== 'function') return 0
    let changed = 0
    for (const record of state.agents.values()) {
      if (record.agent === undefined) continue
      try {
        const installed = typeof agents.selectionFor === 'function' ? agents.selectionFor(record.agent) : undefined
        const current = installed ? installed.current : undefined
        if (current !== undefined && current !== null && current.provider === provider
          && modelState.allowed.has(current.model)) continue
        agents.selectForNextRequest(record.agent, { provider, model })
        changed += 1
        journal('reselect agent=' + record.label + ' -> ' + provider + '/' + model)
      } catch (error) {
        journal('ERROR reselect ' + record.label + ': ' + messageOf(error))
      }
    }
    return changed
  }

  /**
   * Если текущая модель вне прав нового ключа — поставить доступную.
   *
   * Решение (ревью хрупких мест): подмена ОСТАЁТСЯ (иначе сессия просто умирает на 403), но
   * перестала быть молчаливой и перестала трогать чужое:
   *   • конфиг пользователя (saveSelection) пишем только при persistDefaultModelSwap=true;
   *   • живых агентов переставляем только при reselectAgentsOnModelLoss=true (по умолчанию нет:
   *     подмена модели посреди хода меняет стоимость/поведение уже начатой работы);
   *   • событие всегда видно: журнал + modelState.defaultSwap в /api/state.
   */
  const ensureDefaultModel = async () => {
    if (!modelState.known || modelState.provider === '' || modelState.allowed.size === 0) return
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || typeof service.currentSelection !== 'function') return
    const readBase = defaultGuard.base !== null ? () => defaultGuard.base.call(service) : () => service.currentSelection()
    let current
    try {
      current = readBase()
    } catch {
      return
    }
    const currentAllowed = current !== undefined && current !== null && current.provider === modelState.provider
      && typeof current.model === 'string' && modelState.allowed.has(current.model)
    if (currentAllowed) {
      installDefaultSubstitute(null)
      modelState.defaultSwap = null
      return
    }
    const first = [...modelState.allowed][0]
    if (first === undefined) return
    const from = current ? current.provider + '/' + current.model : 'unset'
    const to = modelState.provider + '/' + first
    let persisted = false
    if (cfg.persistDefaultModelSwap === true) {
      try {
        await service.saveSelection({ provider: modelState.provider, model: first })
        persisted = true
        journal('default model persisted -> ' + to)
      } catch (error) {
        journal('saveSelection refused (' + messageOf(error) + ') — подмена в памяти')
      }
    }
    installDefaultSubstitute(persisted ? null : { provider: modelState.provider, model: first })
    const changed = cfg.reselectAgentsOnModelLoss === true ? reselectLiveAgents(modelState.provider, first) : 0
    modelState.defaultSwap = { at: Date.now(), from, to, persisted, reassignedAgents: changed }
    journal('WARN default model unavailable (' + from + ') -> substituted ' + to
      + ' (persisted=' + String(persisted) + ', agents reassigned=' + changed
      + '; включи persistDefaultModelSwap/reselectAgentsOnModelLoss, если нужно иначе)')
    log('warn', 'выбранной модели нет в правах ключа: ' + from + ' → ' + to
      + ' (конфиг ' + (persisted ? 'обновлён' : 'не тронут') + ', живых агентов переставлено: ' + changed + ')')
  }

  /**
   * Записать ключ активного токена в СВОЙ ref провайдера: снимок прежнего значения + set.
   * Чужой ref запрещён конфигом — сюда попадает только MCP_ACCESS_*.
   * @param {string} key - LiteLLM-ключ активного токена.
   * @param {string} tokenId - id активного токена (для журнала).
   * @returns {Promise<boolean>} true — ключ в сторе.
   */
  const writeProviderKey = async (key, tokenId) => {
    const ref = String(cfg.llmSecretRef || '')
    if (!isOwnRef(ref)) {
      modelState.keyState = 'config-invalid'
      modelState.error = 'llmSecretRef "' + ref + '" вне пространства ' + OWN_REF_PREFIX + '*: запись запрещена'
      journal('ERROR ' + modelState.error)
      return false
    }
    await snapshotCredential(ref, key)
    try {
      const current = await readSecret(ref)
      if (current === key) return true
      await ctx.credentials.set(credentialRef(ref), key)
      journal('models: key of token ' + tokenId + ' -> ref ' + ref + ' length=' + key.length)
      return true
    } catch (error) {
      modelState.keyState = 'error'
      modelState.error = 'credentials.set: ' + messageOf(error)
      journal('ERROR ' + modelState.error)
      return false
    }
  }

  /**
   * Применить модельную часть активного токена: ключ → свой ref, каталог → /v1/models, модель → доступная.
   * @param {string} tokenId - id активного токена.
   */
  const applyModelAccess = async (tokenId) => {
    const token = catalog.tokens.get(tokenId)
    modelState.provider = String(cfg.llmProvider || '')
    modelState.baseUrl = llmBaseUrl()
    modelState.keyRef = token ? token.keyRef : ''
    if (!modelSyncEnabled) {
      modelState.keyState = 'disabled'
      modelState.error = cfg.modelSync !== true ? '' : 'модельная часть выключена (проверь llmProvider/llmSecretRef/llmBaseUrl)'
      installDefaultSubstitute(null)
      journal('models: sync disabled (provider=' + modelState.provider + ' secret=' + String(cfg.llmSecretRef || '') + ')')
      return
    }
    if (token === undefined) {
      // активного токена нет (удалили последний): доступа нет и ключ провайдера не держим
      modelState.keyState = 'no-token'
      modelState.error = ''
      modelState.known = false
      modelState.allowed = new Set()
      installDefaultSubstitute(null)
      const providerRef = String(cfg.llmSecretRef || '')
      if (isOwnRef(providerRef)) {
        try {
          await ctx.credentials.unset(credentialRef(providerRef))
          journal('models: no active token — unset provider ref ' + providerRef)
        } catch (error) {
          journal('ERROR models: unset provider ref: ' + messageOf(error))
        }
      }
      return
    }
    const key = modelState.keyRef !== '' ? await readSecret(modelState.keyRef) : ''
    if (key === '') {
      // Каталог НЕ разворачиваем в «всё разрешено»: держим последний известный allowlist (ревью F7).
      modelState.keyState = 'no-key'
      modelState.error = 'token has no LiteLLM key'
      installDefaultSubstitute(null)
      journal('models: token ' + tokenId + ' has no key in ' + modelState.keyRef
        + ' (каталог держим: ' + (modelState.known ? modelState.allowed.size + ' моделей' : 'неизвестен') + ')')
      return
    }
    if (!(await writeProviderKey(key, tokenId))) {
      installDefaultSubstitute(null)
      return
    }
    const discovery = await discoverModels(key)
    if (discovery.error !== undefined) {
      modelState.keyState = 'error'
      modelState.error = discovery.error
      installDefaultSubstitute(null)
      journal('ERROR discovery: ' + discovery.error
        + ' (каталог держим: ' + (modelState.known ? modelState.allowed.size + ' моделей' : 'неизвестен') + ')')
      return
    }
    modelState.keyState = 'ok'
    modelState.error = ''
    modelState.fetchedAt = Date.now()
    modelState.limits = discovery.limits instanceof Map ? discovery.limits : new Map()
    // Ручные ёмкости оператора перекрывают шлюзовые: шлюз отдаёт их не для всех моделей.
    for (const [modelId, override] of Object.entries(cfg.modelLimits || {})) {
      if (override === null || typeof override !== 'object') continue
      const merged = { ...(modelState.limits.get(modelId) || {}) }
      if (typeof override.contextWindow === 'number') merged.contextWindow = override.contextWindow
      if (typeof override.maxTokens === 'number') merged.maxTokens = override.maxTokens
      if (Object.keys(merged).length > 0) modelState.limits.set(modelId, merged)
    }
    // Потолок вывода: объявленный вывод DSH вычитает из окна целиком, поэтому огромный
    // maxTokens из шлюза (opus 64000 при окне 200000) съедает четверть окна до первого хода.
    const cap = Number(cfg.maxOutputTokensCap) || 0
    if (cap > 0) {
      for (const [modelId, entry] of modelState.limits) {
        if (typeof entry.maxTokens === 'number' && entry.maxTokens > cap) {
          modelState.limits.set(modelId, { ...entry, maxTokens: cap })
        }
      }
    }
    const keyModels = new Set(discovery.ids)
    const narrowed = token !== undefined && token.models.length > 0
      ? new Set(token.models.filter((model) => keyModels.has(model)))
      : keyModels
    if (narrowed.size === 0) {
      // Ревью F3: пустое пересечение token.models ∩ keyModels не должно давать пустой каталог.
      modelState.allowed = keyModels
      modelState.degraded = true
      journal('ERROR models: token.models ∩ keyModels пусто — каталог развёрнут до прав ключа ('
        + keyModels.size + ' моделей), поле models[] у токена ' + tokenId + ' игнорируется')
    } else {
      modelState.allowed = narrowed
      modelState.degraded = false
      journal('models: key of token ' + tokenId + ' allows ' + keyModels.size + ' model(s): ' + [...keyModels].join(',')
        + (narrowed.size !== keyModels.size ? ' (пересечение с models[]: ' + narrowed.size + ')' : ''))
    }
    modelState.known = true
    await ensureDefaultModel()
  }

  /* ─────────────────────── M2: гейт MCP-тулзов по агенту ─────────────────────── */

  /** Все mcp__-имена глобального слоя (реестр тулзов — источник правды). */
  const globalMcpToolNames = () => {
    let schemas = []
    try {
      schemas = ctx.tools.schemas()
    } catch (error) {
      log('warn', 'ctx.tools.schemas() отказал: ' + messageOf(error))
      return []
    }
    return schemas
      .map((schema) => schema.name)
      .filter((toolName) => typeof toolName === 'string' && toolName.startsWith('mcp__'))
  }

  /**
   * Разрешён ли публичный MCP-тулз ЗАКОММИЧЕННЫМИ грантами (сервер в гранте + имя в allowlist).
   * @param {string} publicName - model-facing имя (mcp__<server>__<raw>).
   * @returns {boolean} true — тулз в грантах.
   */
  const toolAllowed = (publicName) => {
    for (const grant of state.grants.values()) {
      const prefix = 'mcp__' + grant.serverName + '__'
      if (!publicName.startsWith(prefix)) continue
      // токен сервера отвергнут (verifyTool -> 401/403): тулзы запрещены, пока токен не заменят
      if (state.tokenRejected.has(grant.serverName)) return false
      if (grant.all) return true
      for (const raw of grant.tools) {
        if (publicToolName(grant.serverName, raw) === publicName) return true
      }
      return false
    }
    return false
  }

  /**
   * Принадлежит ли имя серверу, которым плагин управляет (сейчас или в прошлых поколениях).
   * @param {string} publicName - model-facing имя тулза.
   * @returns {boolean} true — имя нашего сервера.
   */
  const isManagedTool = (publicName) => {
    for (const serverName of state.everManaged) {
      if (publicName.startsWith('mcp__' + serverName + '__')) return true
    }
    for (const serverName of state.managedNames) {
      if (publicName.startsWith('mcp__' + serverName + '__')) return true
    }
    return false
  }

  /** Реентрантность: restrict() синхронно эмитит tools/change — гасим повторный вход. */
  const applyGuard = { active: false, dirty: false }

  /**
   * Полный набор запретов агента: при барьере — все управляемые тулзы, иначе всё вне грантов.
   * Пересчёт, а не инкремент (ревью F6: залипшие запреты у агентов из окна смены).
   * @param {object} record - запись агента.
   * @returns {string[]} имена к запрету.
   */
  const desiredDenied = (record) => {
    void record
    // Запрет считается по объединению «сейчас в реестре» и «когда-либо видели»: restrict() сам
    // эмитит tools/change, набор уменьшался после каждого применения и гейт зацикливался
    // (в журнале десятки строк denied=9…2 на одно применение).
    const names = new Set(state.knownManagedTools)
    for (const toolName of globalMcpToolNames()) {
      if (!isManagedTool(toolName)) continue
      names.add(toolName)
      state.knownManagedTools.add(toolName)
    }
    const list = [...names]
    if (state.barrier) return list
    return list.filter((toolName) => !toolAllowed(toolName))
  }

  /**
   * Живые агенты из реестра хоста (R7). Плагин может включиться на инстансе, где агенты уже живут:
   * для них `agent/created` не повторится, поэтому реестр `agents` — единственный источник списка.
   * @returns {object[]} массив Agent (пустой, если сервис недоступен).
   */
  const liveAgents = () => {
    try {
      const registry = ctx.get('agents')
      if (registry === undefined || registry === null || typeof registry.list !== 'function') return []
      const agents = registry.list()
      if (!Array.isArray(agents)) return []
      return agents.filter((agent) => agent !== undefined && agent !== null && agent.ctx !== undefined)
    } catch (error) {
      log('warn', 'live agents: ' + messageOf(error))
      return []
    }
  }

  /**
   * Завести запись агента (гейт применяется отдельно через reconcileGates).
   * @param {object} agent - Agent хоста.
   * @param {string} source - 'agent/created' | 'startup-enumeration' | 'apply'.
   * @returns {object|undefined} запись либо undefined (уже была/непригодна).
   */
  const registerAgent = (agent, source) => {
    if (agent === undefined || agent === null || state.agents.has(agent)) return undefined
    if (agent.ctx === undefined) return undefined
    const record = {
      label: String((agent.session && agent.session.id) || agent.id || 'agent') + '#' + (state.agents.size + 1),
      agent,
      ctx: agent.ctx,
      scope: scopeOf(agent.ctx),
      hidden: new Set(),
      disposers: [],
    }
    state.agents.set(agent, record)
    const adopted = source === 'startup-enumeration'
    journal('agent ' + (adopted ? 'adopted' : 'created') + ' ' + record.label
      + (adopted ? ' (жил до старта/перезагрузки плагина)' : ''))
    return record
  }

  /**
   * Перечислить живых агентов и завести отсутствующие записи (R7): без этого агенты, созданные до
   * старта/перезагрузки плагина, остаются без гейта — fail-open на ровно том сценарии установки,
   * когда плагин включают на инстансе с живыми агентами.
   * @param {string} source - метка причины в журнале.
   * @returns {number} сколько записей добавлено.
   */
  const adoptLiveAgents = (source) => {
    const live = liveAgents()
    state.agentsSeen = live.length
    let adopted = 0
    for (const agent of live) {
      if (registerAgent(agent, source) !== undefined) adopted += 1
    }
    if (adopted > 0) journal('agents adopted count=' + adopted + '/' + live.length + ' source=' + source)
    return adopted
  }

  /**
   * Отчёт о гейте живых агентов (R7) для /api/diag: candidates — сколько агентов видит реестр,
   * gated — скольким применён ровно актуальный набор запретов, ungated — расхождение поимённо.
   * @returns {{candidates: number, gated: number, ungated: string[], records: number}} отчёт.
   */
  const agentsGateReport = () => {
    const live = liveAgents()
    const ungated = []
    let gated = 0
    for (const agent of live) {
      const record = state.agents.get(agent)
      if (record === undefined) {
        ungated.push(String((agent.session && agent.session.id) || 'agent') + ' (нет записи)')
        continue
      }
      const desired = desiredDenied(record)
      const same = desired.length === record.hidden.size && desired.every((name) => record.hidden.has(name))
      if (same) gated += 1
      else ungated.push(record.label)
    }
    state.agentsSeen = live.length
    state.agentsGated = gated
    state.agentsUngated = ungated
    return { candidates: live.length, gated, ungated, records: state.agents.size }
  }

  /** Снять все наши слои restrict у агента. */
  const releaseAgentLayers = (record) => {
    for (const disposer of record.disposers) {
      try {
        disposer()
      } catch {
        /* уже снят */
      }
    }
    record.disposers = []
    record.hidden = new Set()
  }

  /**
   * Привести запреты агента к желаемому набору одним синхронным коммитом: снять свои слои и поставить
   * ровно новый набор (между снятием и постановкой нет await — окна нет).
   * @param {object} record - запись агента.
   */
  const reconcileGates = (record) => {
    const desired = desiredDenied(record)
    const current = [...record.hidden]
    const same = desired.length === current.length && desired.every((name) => record.hidden.has(name))
    if (same) return
    if (desired.length === 0) {
      releaseAgentLayers(record)
      return
    }
    // Сначала ставим новый слой, и только после успеха снимаем прежний: если снять первым, а
    // restrict откажет, у агента не останется ни одного запрета — fail-open на живом инстансе.
    let disposer
    try {
      // Реестр тулзов — источник правды, поэтому имена заведомо известны (ревью F11: без парсинга ошибок).
      disposer = record.ctx.tools.restrict({ deny: desired })
    } catch (error) {
      const message = messageOf(error)
      log('warn', 'tools.restrict() отказал у агента ' + record.label + ': ' + message)
      journal('ERROR restrict agent=' + record.label + ': ' + message)
      // Старые запреты остаются в силе: лучше устаревший запрет, чем открытый доступ.
      return
    }
    const previous = record.disposers
    record.disposers = [disposer]
    record.hidden = new Set(desired)
    for (const old of previous) {
      try {
        old()
      } catch {
        /* уже снят */
      }
    }
    journal('gate agent=' + record.label + ' denied=' + desired.length
      + ' [' + desired.slice(0, 3).join(',') + (desired.length > 3 ? ',…' : '') + ']'
      + (state.barrier ? ' (barrier)' : ''))
  }

  /** Один проход по всем живым агентам с защитой от реентрантности. */
  const applyAgentGates = () => {
    if (applyGuard.active) {
      applyGuard.dirty = true
      return
    }
    applyGuard.active = true
    try {
      // R7: сначала подбираем агентов, живших до старта плагина, иначе проход их не увидит.
      adoptLiveAgents('apply')
      for (const record of state.agents.values()) {
        try {
          reconcileGates(record)
        } catch (error) {
          log('warn', 'гейт агента упал: ' + messageOf(error))
        }
      }
    } finally {
      applyGuard.active = false
    }
    if (applyGuard.dirty) {
      applyGuard.dirty = false
      applyAgentGates()
    }
  }

  /* ─────────────────── авто-ретрай шлюза (R3) ─────────────────── */

  /** Состояние авто-ретрая: попытки, время следующей, причина последнего сбоя. */
  const retryState = { attempts: 0, nextRetryAt: 0, lastError: '' }
  let retryTimer

  /** Снять запланированный повтор (ручной refresh, успех, dispose). */
  const clearRetry = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    retryState.nextRetryAt = 0
  }

  /** Сбросить авто-ретрай: применяется, когда состояние снова ready. */
  const resetRetry = () => {
    clearRetry()
    retryState.attempts = 0
    retryState.lastError = ''
  }

  /**
   * Запланировать ограниченный автоповтор: первые попытки по retryDelaysMs (1/3/9 с ±15% jitter),
   * дальше — фоновый повтор раз в retryBackgroundMs, пока состояние degraded.
   * Таймер не держит процесс (unref) и заменяется новым при каждом применении.
   */
  const scheduleRetry = () => {
    clearRetry()
    const delays = Array.isArray(cfg.retryDelaysMs) && cfg.retryDelaysMs.length > 0
      ? cfg.retryDelaysMs.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : DEFAULT_RETRY_DELAYS_MS
    const background = Number(cfg.retryBackgroundMs) > 0 ? Number(cfg.retryBackgroundMs) : DEFAULT_RETRY_BACKGROUND_MS
    const base = retryState.attempts < delays.length ? delays[retryState.attempts] : background
    const delay = Math.max(100, Math.round(base * (0.85 + Math.random() * 0.3)))
    retryState.attempts += 1
    retryState.lastError = state.lastError || state.registryError || ('phase=' + state.phase)
    retryState.nextRetryAt = Date.now() + delay
    journal('retry #' + retryState.attempts + ' через ' + delay + ' мс (причина: ' + retryState.lastError + ')')
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      retryState.nextRetryAt = 0
      applyActiveToken('auto-retry#' + retryState.attempts).catch((error) => {
        journal('ERROR auto-retry: ' + messageOf(error))
        scheduleRetry()
      })
    }, delay)
    if (typeof retryTimer.unref === 'function') retryTimer.unref()
  }

  /**
   * Итог применения: успех сбрасывает авто-ретрай, ошибка — планирует следующий повтор.
   */
  const settleRetry = () => {
    if (state.lastError === '') resetRetry()
    else scheduleRetry()
  }

  /* ─────────────────────── двухфазное применение токена ─────────────────────── */

  /**
   * Применить активный токен двухфазно (ревью P1-3/F4):
   *   A) барьер: запретить ВСЁ управляемое всем живым агентам и снять все монтирования;
   *   B) посчитать и смонтировать новый набор (реестр + env + ключ) и применить модели;
   *   C) коммит грантов одним синхронным блоком + финальный гейт по новому allowlist.
   * Гранты/managedNames не обнуляются в окне: диагностика всегда показывает либо старый набор с
   * запретами, либо новый набор с запретами.
   * @param {string} reason - метка для журнала.
   * @param {string} [nextTokenId] - новый активный токен: сохраняется ПОСЛЕ подъёма барьера (R1).
   */
  const applyNow = async (reason, nextTokenId, only) => {
    const started = Date.now()
    // Точечное применение — смена личного значения одного сервера: не поднимаем общий барьер и не
    // трогаем чужие монтирования (иначе запись ключа PDM перемонтировала все MCP и на пару секунд
    // запрещала тулзы всем агентам).
    const targeted = only instanceof Set ? only : undefined
    /** Записи «не смонтирован по причине», снятые точечным применением: возвращаются, если сервер вне грантов. */
    const restoreRecords = new Map()
    state.phase = 'switching'
    if (targeted === undefined) {
      state.barrier = true
      applyAgentGates()
    }
    // R1: сначала барьер deny-all, только потом смена activeToken — иначе diag врёт парой
    // «новый токен + старый allowlist» (в окно попадал ещё и await saveActiveToken).
    if (nextTokenId !== undefined && nextTokenId !== state.activeToken) {
      state.activeToken = nextTokenId
      try {
        await saveActiveToken(nextTokenId)
      } catch (error) {
        state.lastError = 'saveActiveToken: ' + messageOf(error)
        journal('ERROR ' + state.lastError)
      }
    }
    if (targeted === undefined) {
      await unmountAll()
      // Статусы «не смонтирован по причине» пересчитываются ниже с нуля: записи прошлого применения
      // не должны переживать новое (иначе, например, сервер с личным ключом висит в старом статусе).
      for (const [serverName, record] of [...state.mounts.entries()]) {
        if (record.fiber === undefined) state.mounts.delete(serverName)
      }
      // Вердикты проверки относятся к прежнему токену и его значениям: под новым ключом они
      // недействительны, а залипший token-rejected держал бы фазу degraded бесконечно.
      if (state.verify.size > 0 || state.tokenRejected.size > 0) {
        journal('вердикты сброшены: смена токена/набора (' + state.verify.size + '/' + state.tokenRejected.size + ')')
      }
      state.verify.clear()
      state.tokenRejected.clear()
      for (const serverName of new Set([...state.everManaged, ...state.managedNames])) {
        state.verifyEpoch.set(serverName, verifyEpochOf(serverName) + 1)
      }
    } else {
      for (const serverName of targeted) {
        // Сервер вне грантов не перемонтируется: его прежнюю запись вернём, чтобы статус с
        // причиной («нужен ключ сервиса») не превратился в «не подключён» с пустой ошибкой.
        const previous = state.mounts.get(serverName)
        if (previous !== undefined && previous.fiber === undefined) restoreRecords.set(serverName, previous)
        await unmount(serverName)
      }
    }
    let prepared = { grants: new Map(), managedNames: new Set(), ok: false }
    let failure = ''
    try {
      prepared = await prepareMounts(reason, targeted)
    } catch (error) {
      failure = messageOf(error)
      journal('ERROR prepare: ' + failure)
    }
    // Коммит новых грантов — один синхронный блок, до снятия барьера.
    state.grants = prepared.grants
    state.managedNames = prepared.managedNames
    for (const serverName of prepared.managedNames) state.everManaged.add(serverName)
    for (const [serverName, previous] of restoreRecords) {
      if (!state.mounts.has(serverName)) state.mounts.set(serverName, previous)
    }
    if (prepared.ok) state.lastError = failure
    else if (state.registryError !== '') state.lastError = state.registryError
    else if (state.keyHealthError !== '') state.lastError = 'ключ не подтвердился (GET /v1/models: ' + state.keyHealthError + ')'
    else if (state.envStatusError !== '') state.lastError = 'статус личных значений недоступен: ' + state.envStatusError
    else state.lastError = failure
    if (targeted === undefined) {
      try {
        await applyModelAccess(state.activeToken)
      } catch (error) {
        journal('ERROR models: ' + messageOf(error))
      }
      state.barrier = false
    }
    // монтирования идут асинхронно: 'starting' до тех пор, пока хоть один сервер не осел
    if (targeted === undefined) state.phase = state.lastError !== '' ? 'degraded' : 'starting'
    settlePhase()
    applyAgentGates()
    state.generation += 1
    // Модели точечное применение не меняет — адаптеры не перетряхиваем.
    if (targeted === undefined) {
      try {
        ctx.emit('llm/adapters-updated')
      } catch (error) {
        log('warn', 'emit llm/adapters-updated: ' + messageOf(error))
      }
    }
    journal('apply#' + state.generation + ' token=' + state.activeToken + ' phase=' + state.phase
      + ' mounts=' + [...state.mounts.values()].filter((record) => record.status !== 'failed' && record.status !== 'no-token' && record.status !== 'no-env' && record.status !== 'key-error').length
      + ' registry=' + state.registry.size
      + ' models=' + (modelState.known ? modelState.allowed.size : 'unknown')
      + ' ms=' + (Date.now() - started) + ' (' + reason + (targeted === undefined ? '' : ', только ' + [...targeted].join(',')) + ')')
    settleRetry()
  }

  /**
   * Публичная точка применения: сериализована очередью (ревью P1-4).
   * @param {string} reason - метка для журнала.
   * @param {string} [nextTokenId] - новый активный токен (R1: применяется, когда барьер уже поднят).
   * @returns {Promise<void>} завершение применения.
   */
  const applyActiveToken = (reason, nextTokenId) => serialise(() => applyNow(reason, nextTokenId))

  /**
   * Точечное применение: перемонтировать только названные серверы (запись личного значения одного
   * сервера). Гранты, модели и чужие монтирования не трогаются — без общего барьера и без
   * перемонтирования всего набора.
   * @param {string} reason - метка для журнала.
   * @param {string[]} names - имена серверов в шлюзе.
   * @returns {Promise<void>} завершение применения.
   */
  const applyServers = (reason, names) => {
    const set = new Set(names)
    if (set.size === 0) return Promise.resolve()
    return serialise(() => applyNow(reason, undefined, set))
  }

  /* ─────────────────────── персист состояния (активный токен + токены экрана) ─────────────────────── */

  /**
   * Нормализовать токен из stateFile: та же форма, что у токена конфига, плюс метка происхождения.
   * @param {object} raw - запись из stateFile.
   * @returns {object|undefined} токен для catalog.tokens либо undefined (запись негодная).
   */
  const normalizeUiToken = (raw) => {
    if (raw === null || typeof raw !== 'object') return undefined
    const id = String(raw.id || '')
    if (id === '') return undefined
    const grants = new Map()
    for (const grant of Array.isArray(raw.servers) ? raw.servers : []) {
      const granted = String((grant && grant.server) || '')
      if (granted === '') continue
      const tools = (Array.isArray(grant.tools) ? grant.tools : []).filter((tool) => typeof tool === 'string' && tool !== '')
      grants.set(granted, { tools, all: tools.length === 0 })
    }
    const keyRef = typeof raw.keyRef === 'string' && raw.keyRef !== '' ? raw.keyRef : tokenKeyRef(id)
    return {
      id,
      label: typeof raw.label === 'string' ? raw.label : '',
      servers: grants,
      keyRef,
      models: [],
      group: '',
      source: 'ui',
    }
  }

  /**
   * Прочитать состояние из stateFile: активный токен, токены экрана, скрытые токены конфига.
   * Отсутствующий/битый файл — не ошибка: работаем на конфиге.
   * @returns {Promise<{activeToken: string, tokens: object[], hidden: string[]}>} прочитанное состояние.
   */
  const loadStateDoc = async () => {
    const fallback = { activeToken: cfg.activeToken || '', tokens: [], hidden: [] }
    if (stateFile === '') return fallback
    let parsed
    try {
      parsed = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch {
      return fallback
    }
    if (parsed === null || typeof parsed !== 'object') return fallback
    return {
      activeToken: typeof parsed.activeToken === 'string' ? parsed.activeToken : (cfg.activeToken || ''),
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens.map(normalizeUiToken).filter((token) => token !== undefined) : [],
      hidden: Array.isArray(parsed.hiddenTokens) ? parsed.hiddenTokens.map((id) => String(id)).filter((id) => id !== '') : [],
      serverNames: Array.isArray(parsed.serverNames) ? parsed.serverNames.map((name) => String(name)).filter((name) => name !== '') : [],
    }
  }

  /** @returns {object} документ состояния для stateFile (без секретов: только факты о токенах). */
  const stateDoc = () => ({
    version: 2,
    activeToken: state.activeToken,
    tokens: [...uiTokens.values()].map((token) => ({
      id: token.id,
      label: token.label,
      keyRef: token.keyRef,
      servers: [...token.servers.entries()].map((entry) => ({
        server: entry[0],
        tools: entry[1].all ? [] : [...entry[1].tools],
      })),
    })),
    hiddenTokens: [...hiddenTokens],
    // Состав серверов переживает рестарт: без активного токена экран всё равно показывает строки с причиной.
    serverNames: [...state.lastServerNames],
    updatedAt: new Date().toISOString(),
  })

  /**
   * Записать состояние: уникальный tmp (pid+uuid), атомарный rename с retry (ревью P1-4), права 0600.
   * Очередь применения уже сериализована, retry — страховка от внешних гонок.
   */
  const saveStateDoc = async () => {
    if (stateFile === '') return
    await mkdir(dirname(stateFile), { recursive: true })
    const payload = JSON.stringify(stateDoc(), null, 2) + '\n'
    let lastError
    for (let attempt = 0; attempt < MAX_TMP_RENAME_ATTEMPTS; attempt += 1) {
      const tmp = stateFile + '.tmp-' + process.pid + '-' + randomUUID()
      try {
        await writeFile(tmp, payload, { mode: 0o600 })
        await rename(tmp, stateFile)
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
    journal('ERROR saveState: ' + messageOf(lastError))
    throw lastError
  }

  /**
   * Сделать токен активным в памяти и персисте.
   * @param {string} tokenId - id активного токена.
   */
  const saveActiveToken = async (tokenId) => {
    state.activeToken = tokenId
    await saveStateDoc()
  }

  /* ─────────────────────── M4: страница и HTTP API ─────────────────────── */

  const json = (res, code, value) => {
    try {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(value))
    } catch {
      /* клиент отвалился */
    }
  }

  /**
   * Периметр ручек (ревью P1-1/F1): тот же шов, что у /api DSH — Host/Origin-фенс + браузерная
   * аутентификация (ctx.connection.requestRejection). Без сервиса connection ручки не работают (503).
   * @param {object} req - IncomingMessage.
   * @param {object} res - ServerResponse.
   * @returns {boolean} true — запрос отклонён (ответ уже отправлен).
   */
  const rejected = (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      json(res, 503, { error: 'connection service unavailable: refusing unauthenticated access' })
      return true
    }
    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch (error) {
      log('warn', 'requestRejection: ' + messageOf(error))
      json(res, 503, { error: 'request rejection failed: refusing access' })
      return true
    }
    if (rejection === undefined) return false
    journal('auth reject ' + String(req.method) + ' ' + String(req.url) + ' -> ' + rejection)
    try {
      res.writeHead(rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end(String(rejection))
    } catch {
      /* клиент отвалился */
    }
    return true
  }

  /**
   * Тело POST: только application/json (ревью P1-1: text/plain simple request не должен проходить).
   * @param {object} req - IncomingMessage.
   * @param {object} res - ServerResponse.
   * @returns {Promise<object|null>} разобранное тело либо null (ответ уже отправлен).
   */
  const readJsonBody = async (req, res) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      json(res, 415, { error: 'Content-Type must be application/json (got "' + contentType + '")' })
      return null
    }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        json(res, 413, { error: 'body too large' })
        return null
      }
      chunks.push(chunk)
    }
    if (size === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      json(res, 400, { error: 'invalid JSON body' })
      return null
    }
  }

  /* ─────────────────────── промпты-инструкции для сессии ─────────────────────── */

  /**
   * Встроенный набор промптов: каталог `prompts/` рядом с этим файлом. Его наполняет
   * scripts/sync-prompts.mjs из deploy/dsh-bootstrap, поэтому раздел работает без настройки.
   */
  const BUNDLED_PROMPTS_DIR = fileURLToPath(new URL('./prompts/', import.meta.url))

  /**
   * Откуда брать промпты: явная настройка promptsDir сильнее встроенного набора.
   * @returns {{ dir: string, source: 'config'|'bundled' }} каталог и признак источника.
   */
  const promptsSource = () => {
    const configured = String(cfg.promptsDir || '').trim()
    return configured === '' ? { dir: BUNDLED_PROMPTS_DIR, source: 'bundled' } : { dir: configured, source: 'config' }
  }

  /**
   * Заголовок промпта: первый markdown-заголовок «# …» в начале файла, иначе имя без расширения.
   * @param {string} text - начало файла.
   * @param {string} fallback - имя файла без .md.
   * @returns {string} заголовок для списка.
   */
  const promptTitle = (text, fallback) => {
    for (const line of String(text).split('\n').slice(0, 40)) {
      const match = /^#\s+(.+)$/.exec(line.trim())
      if (match !== null) return match[1].trim()
    }
    return fallback
  }

  /**
   * Промпты каталога для раздела на экране: id (имя файла), заголовок, размер, дата изменения.
   * Рекурсии нет: читаются только *.md верхнего уровня — предсказуемый набор, без обхода дерева.
   * @returns {Promise<{ dir: string, prompts: object[], error: string }>} срез для клиента.
   */
  const listPrompts = async () => {
    const { dir, source } = promptsSource()
    let names = []
    try {
      names = (await readdir(dir)).filter((name) => /\.md$/i.test(name))
    } catch (error) {
      const hint = source === 'bundled'
        ? 'встроенный набор промптов не найден, переустановите плагин'
        : 'каталог promptsDir не читается'
      return { dir, source, prompts: [], error: hint + ': ' + messageOf(error) }
    }
    names.sort((a, b) => a.localeCompare(b, 'ru'))
    const prompts = []
    for (const name of names) {
      try {
        const path = join(dir, name)
        const info = await stat(path)
        if (!info.isFile()) continue
        // Заголовок берём из первых килобайт: полноразмерные инструкции бывают на 20-25 КБ.
        const handle = await readFile(path, 'utf8')
        prompts.push({
          id: name,
          title: promptTitle(handle.slice(0, 4096), name.replace(/\.md$/i, '')),
          bytes: info.size,
          updatedAt: info.mtimeMs,
        })
      } catch (error) {
        journal('ERROR prompts: ' + name + ': ' + messageOf(error))
      }
    }
    return { dir, source, prompts, error: '' }
  }

  /**
   * Текст промпта по id. id — только базовое имя *.md из каталога промптов (никаких путей).
   * @param {string} id - имя файла из списка.
   * @returns {Promise<{ id?: string, title?: string, text?: string, error?: string }>} промпт или ошибка.
   */
  const readPrompt = async (id) => {
    const { dir } = promptsSource()
    const name = String(id || '').trim()
    if (name === '' || name !== basename(name) || !/\.md$/i.test(name)) return { error: 'недопустимый id промпта' }
    try {
      const text = await readFile(join(dir, name), 'utf8')
      return { id: name, title: promptTitle(text.slice(0, 4096), name.replace(/\.md$/i, '')), text }
    } catch (error) {
      return { error: 'промпт не читается: ' + messageOf(error) }
    }
  }

  /**
   * Текущая модель по умолчанию (seam ctx.agentDefaultModel).
   * @returns {{provider: string, model: string} | null} выбор или null.
   */
  function currentSelection() {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || typeof service.currentSelection !== 'function') return null
    try {
      const selection = service.currentSelection()
      return selection === undefined || selection === null ? null : { provider: selection.provider, model: selection.model }
    } catch {
      return null
    }
  }

  /**
   * Серверы, которые шлюз выдаёт активному ключу (реестр `GET /v1/mcp/server`), — единственный
   * источник списка. Конфиг плагина может сузить набор и подписать сервер, но не добавить:
   * объявленный в конфиге сервер без гранта в списке не появляется (см. configOnlyServers).
   * @returns {object[]} нормализованные серверы.
   */
  const serverEntries = () => {
    const seen = new Set()
    const entries = []
    for (const serverName of state.registry.keys()) {
      const server = resolveServer(serverName)
      if (server === undefined) continue
      if (seen.has(server.name)) continue
      seen.add(server.name)
      entries.push(server)
    }
    return entries
  }

  /**
   * Серверы, объявленные в конфиге плагина, которых шлюз активному ключу не выдаёт.
   * @returns {string[]} имена из конфига без гранта.
   */
  const configOnlyServers = () => [...catalog.servers.keys()].filter((name) => !state.registry.has(name))

  /**
   * Состояние авто-ретрая шлюза для /api/state и /api/diag (R3).
   * @returns {{attempts: number, nextRetryAt: (string|null), retryInMs: (number|null), lastError: string}} снимок.
   */
  const describeRetry = () => ({
    attempts: retryState.attempts,
    nextRetryAt: retryState.nextRetryAt === 0 ? null : new Date(retryState.nextRetryAt).toISOString(),
    retryInMs: retryState.nextRetryAt === 0 ? null : Math.max(0, retryState.nextRetryAt - Date.now()),
    lastError: retryState.lastError,
  })

  /** Последний ответ шлюза о бюджете: id токена, когда спросили и что ответили. */
  const budgetCache = { tokenId: '', at: 0, data: null }

  /**
   * Деньги ключа в шлюзе: расход и лимиты. LiteLLM считает spend сам (LiteLLM_SpendLogs) и
   * отдаёт его виртуальному ключу по GET /key/info; лимит владельца ключа с окном
   * budget_duration — по GET /user/info. У ключа лимита может не быть (max_budget: null) —
   * тогда ограничивает только бюджет пользователя.
   * @param {{id: string, keyRef: string}} token - активный токен.
   * @returns {Promise<object>} блок budget для /api/state.
   */
  const describeBudget = async (token) => {
    const ttl = Math.max(0, Number(cfg.budgetRefreshMs) || 0)
    if (budgetCache.data !== null && budgetCache.tokenId === token.id && Date.now() - budgetCache.at < ttl) {
      return budgetCache.data
    }
    const key = token.keyRef !== '' ? await readSecret(token.keyRef) : ''
    if (key === '') {
      return { tokenId: token.id, key: null, user: null, team: null, today: null, error: 'ключ токена не задан', fetchedAt: Date.now() }
    }
    /** Число из ответа шлюза либо null: LiteLLM кладёт в поля null, когда лимит не задан. */
    const numOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    const keyAnswer = await gatewayGet('/key/info', key)
    const userAnswer = await gatewayGet('/user/info', key)
    const info = keyAnswer.body !== undefined && keyAnswer.body !== null && keyAnswer.body.info ? keyAnswer.body.info : null
    const userInfo = userAnswer.body !== undefined && userAnswer.body !== null && userAnswer.body.user_info ? userAnswer.body.user_info : null
    // Группа = команда LiteLLM, в которую ADFS кладёт пользователя; имя AD-группы лежит в metadata.
    const teamIds = userInfo !== null && Array.isArray(userInfo.teams) ? userInfo.teams.map(String) : []
    const teamId = teamIds.length > 0 ? teamIds[0] : ''
    const teamAnswer = teamId === ''
      ? { body: undefined, error: '' }
      : await gatewayGet('/team/info?team_id=' + encodeURIComponent(teamId), key)
    const teamInfo = teamAnswer.body !== undefined && teamAnswer.body !== null && teamAnswer.body.team_info
      ? teamAnswer.body.team_info
      : null
    // Расход по дням: тот же /spend/logs, но с датами — шлюз отдаёт дневную сводку вместо строк лога.
    const pad = (value) => String(value).padStart(2, '0')
    const dayOf = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    const today = dayOf(new Date())
    const tomorrowDate = new Date(Date.now() + 86400000)
    const weekStartDate = new Date(Date.now() - 6 * 86400000)
    const spendAnswer = await gatewayGet(
      '/spend/logs?start_date=' + dayOf(weekStartDate) + '&end_date=' + dayOf(tomorrowDate),
      key
    )
    const rowByDay = new Map()
    if (Array.isArray(spendAnswer.body)) {
      for (const entry of spendAnswer.body) {
        if (entry === null || entry === undefined) continue
        rowByDay.set(String(entry.startTime || ''), entry)
      }
    }
    // Каждая дневная строка несёт spend и models — берём оба, чтобы клиент мог раскрыть любой день.
    const modelsOfRow = (row) => {
      const models = row.models !== null && row.models !== undefined && typeof row.models === 'object' ? row.models : {}
      const allModels = Object.keys(models)
        .map((name) => ({ model: name, spend: numOf(models[name]) || 0 }))
        .sort((left, right) => right.spend - left.spend)
      // Шлём запасом: обрезка списка — на клиенте, чтобы менять вид без правки хоста.
      return { models: allModels.slice(0, 24), total: allModels.length }
    }
    // Неделя всегда ровно семь точек (нули включительно) — клиенту нечем ошибиться в столбиках.
    const weekDays = []
    for (let back = 6; back >= 0; back -= 1) {
      const day = dayOf(new Date(Date.now() - back * 86400000))
      const row = rowByDay.get(day)
      if (row === undefined) {
        weekDays.push({ day: day, spend: null, models: [], modelsTotal: 0 })
        continue
      }
      const parts = modelsOfRow(row)
      weekDays.push({ day: day, spend: numOf(row.spend), models: parts.models, modelsTotal: parts.total })
    }
    const weekTotal = weekDays.reduce((sum, entry) => sum + (entry.spend === null ? 0 : entry.spend), 0)
    // Сегодняшней строки может не быть при живых прошлых днях — это ноль, а не «нет данных».
    if (weekDays.length > 0 && weekDays[weekDays.length - 1].spend === null && rowByDay.size > 0) {
      weekDays[weekDays.length - 1].spend = 0
    }
    const todayEntry = weekDays.length > 0 ? weekDays[weekDays.length - 1] : null
    const todaySpend = todayEntry === null ? null : todayEntry.spend
    const todayModels = todayEntry === null ? [] : todayEntry.models
    const todayModelsTotal = todayEntry === null ? 0 : todayEntry.modelsTotal
    const data = {
      tokenId: token.id,
      key: info === null ? null : {
        name: String(info.key_name || ''),
        alias: String(info.key_alias || ''),
        spend: numOf(info.spend),
        maxBudget: numOf(info.max_budget),
        budgetDuration: String(info.budget_duration || ''),
        resetAt: String(info.budget_reset_at || ''),
        expires: String(info.expires || ''),
        blocked: info.blocked === true,
        models: Array.isArray(info.models) ? info.models.length : 0,
        lastActive: String(info.last_active || ''),
        owner: info.metadata !== null && info.metadata !== undefined && info.metadata.owner ? String(info.metadata.owner) : '',
        purpose: info.metadata !== null && info.metadata !== undefined && info.metadata.purpose ? String(info.metadata.purpose) : '',
      },
      user: userInfo === null ? null : {
        id: String(userInfo.user_id || ''),
        alias: String(userInfo.user_alias || ''),
        role: String(userInfo.user_role || ''),
        maxBudget: numOf(userInfo.max_budget),
        spend: numOf(userInfo.spend),
        budgetDuration: String(userInfo.budget_duration || ''),
        resetAt: String(userInfo.budget_reset_at || ''),
        keys: Array.isArray(userInfo.keys) ? userInfo.keys.length : 0,
      },
      team: teamInfo === null ? null : {
        id: String(teamInfo.team_id || teamId),
        alias: String(teamInfo.team_alias || ''),
        adfsGroup: teamInfo.metadata !== null && teamInfo.metadata !== undefined && teamInfo.metadata.adfs_group
          ? String(teamInfo.metadata.adfs_group)
          : '',
        members: Array.isArray(teamInfo.members_with_roles) ? teamInfo.members_with_roles.length : 0,
        spend: numOf(teamInfo.spend),
        maxBudget: numOf(teamInfo.max_budget),
        budgetDuration: String(teamInfo.budget_duration || ''),
        resetAt: String(teamInfo.budget_reset_at || ''),
      },
      today: todaySpend === null ? null : { day: today, spend: todaySpend, models: todayModels, modelsTotal: todayModelsTotal },
      week: { days: weekDays, total: weekTotal },
      error: keyAnswer.error || userAnswer.error || teamAnswer.error || spendAnswer.error || '',
      fetchedAt: Date.now(),
    }
    budgetCache.tokenId = token.id
    budgetCache.at = Date.now()
    budgetCache.data = data
    if (data.error !== '') journal('бюджет: ' + data.error)
    return data
  }

  /**
   * Снимок состояния для страницы: серверы (без значений токенов), токены, гранты, монтирования.
   * @returns {Promise<object>} состояние.
   */
  const describeState = async () => {
    const servers = []
    for (const server of serverEntries()) {
      const mount = state.mounts.get(server.name)
      const grant = state.grants.get(server.serverName)
      const registryEntry = state.registry.get(server.name)
      const env = state.envStatus.get(server.name)
      const headerMode = server.tokenHeader !== ''
      const tokenInfo = headerMode ? await describeSecret(server.tokenRef) : { configured: false }
      const storedHeaders = await readServerHeaders(server.name)
      const requiredHeaders = requiredHeaderNames(server, registryEntry)
      servers.push({
        name: server.name,
        label: server.label !== '' ? server.label : (registryEntry && registryEntry.alias) || server.name,
        serverName: server.serverName,
        description: registryEntry ? registryEntry.description : '',
        accessGroups: registryEntry ? registryEntry.accessGroups : [],
        registryKnown: registryEntry !== undefined,
        url: gatewayBase() + '/' + server.name + '/mcp',
        mode: headerMode ? 'header' : (requiredHeaders.length > 0 ? 'client-headers' : (env !== undefined ? 'gateway' : 'none')),
        granted: grant !== undefined,
        toolAllow: grant === undefined ? [] : (grant.all ? ['*'] : [...grant.tools]),
        status: mount ? mount.status : 'not-mounted',
        error: mount ? mount.error : '',
        setupUrl: mount && mount.setupUrl ? mount.setupUrl : (env ? env.setupUrl : ''),
        tokenHeader: server.tokenHeader,
        tokenRef: server.tokenRef,
        tokenConfigured: tokenInfo.configured === true,
        tokenStatus: (state.verify.get(server.name) || {}).status || '',
        tokenHttpCode: (state.verify.get(server.name) || {}).httpCode || 0,
        tokenReason: (state.verify.get(server.name) || {}).reason || '',
        tokenLogin: (state.verify.get(server.name) || {}).login || '',
        tokenCheckedAt: (state.verify.get(server.name) || {}).checkedAt || 0,
        verifyTool: verifyToolOf(server),
        /** id записи в шлюзе: по нему пишем личные значения env var (FR-020). */
        serverId: (env !== undefined && env.serverId !== '' ? env.serverId : '')
          || (registryEntry !== undefined ? registryEntry.serverId : '')
          || '',
        envRequired: env ? env.required : [],
        missingCount: env ? env.missingCount : 0,
        // Что сервер требует от клиента — по его собственной записи в шлюзе, не по конфигу плагина.
        authType: registryEntry ? registryEntry.authType : '',
        isByok: registryEntry ? registryEntry.isByok === true : false,
        byokDescription: registryEntry ? registryEntry.byokDescription : [],
        byokHelpUrl: registryEntry ? registryEntry.byokHelpUrl : '',
        hasUserCredential: registryEntry ? registryEntry.hasUserCredential === true : false,
        /**
         * Заголовки, которые сервис требует от клиента: имя — из записи шлюза (extra_headers или
         * описание сервера), isSet — задано ли значение у нас. Значения наружу не отдаются (NFR-002).
         */
        headerRequired: requiredHeaders.map((name) => ({
          name,
          source: server.tokenHeader === name
            ? 'config'
            : (registryEntry !== undefined && registryEntry.extraHeaders.includes(name) ? 'gateway' : 'description'),
          isSet: typeof storedHeaders[name] === 'string' && storedHeaders[name] !== '',
        })),
        /** Имена заголовков, значения которых уже лежат в credential-store. */
        headerSet: Object.keys(storedHeaders),
        mountedTools: registeredTools(server.serverName),
        /** true — сервер описан в конфиге плагина (его можно выдать новому токену через экран). */
        configured: catalog.servers.has(server.name),
      })
    }
    // Без активного токена реестр пуст, но записи монтирований остаются: иначе экран показывает
    // пустой список и не объясняет, почему серверов нет (FR-017e).
    for (const [serverName, record] of state.mounts) {
      if (servers.some((item) => item.name === serverName)) continue
      servers.push({
        name: serverName,
        label: serverName,
        serverName: record.serverName !== undefined ? record.serverName : serverName,
        description: '',
        accessGroups: [],
        registryKnown: false,
        url: gatewayBase() + '/' + serverName + '/mcp',
        mode: 'none',
        granted: false,
        toolAllow: [],
        status: record.status,
        error: record.error || '',
        setupUrl: record.setupUrl || '',
        tokenHeader: '',
        tokenRef: record.tokenRef || '',
        tokenConfigured: false,
        tokenStatus: '',
        tokenHttpCode: 0,
        tokenReason: '',
        tokenLogin: '',
        tokenCheckedAt: 0,
        verifyTool: '',
        serverId: '',
        envRequired: [],
        missingCount: 0,
        authType: '',
        isByok: false,
        byokDescription: [],
        byokHelpUrl: '',
        hasUserCredential: false,
        headerRequired: [],
        headerSet: [],
        mountedTools: [],
        configured: false,
      })
    }
    const tokens = []
    for (const token of visibleTokens()) {
      const keyInfo = token.keyRef !== '' ? await describeSecret(token.keyRef) : { configured: false }
      tokens.push({
        id: token.id,
        label: token.label !== '' ? token.label : token.id,
        active: token.id === state.activeToken,
        fromConfig: !uiTokens.has(token.id),
        keyRef: token.keyRef,
        keyWritable: isOwnRef(token.keyRef),
        keyConfigured: keyInfo.configured === true,
        group: token.group,
        source: token.source,
        models: token.models,
        servers: [...token.servers.entries()].map((entry) => ({
          server: entry[0],
          tools: entry[1].all ? ['*'] : entry[1].tools,
        })),
      })
    }
    const activeTokenRecord = catalog.tokens.get(state.activeToken)
    return {
      activeToken: state.activeToken,
      /** Деньги активного ключа в шлюзе: расход ключа и недельный лимит его владельца. */
      budget: activeTokenRecord === undefined
        ? { tokenId: '', key: null, user: null, error: 'активный токен не выбран', fetchedAt: Date.now() }
        : await describeBudget(activeTokenRecord),
      /** Скрытые токены конфига: записи в конфиге живы, экран и гранты их не видят. */
      hiddenTokens: [...hiddenTokens].map((id) => {
        const token = catalog.tokens.get(id)
        return { id, label: token !== undefined && token.label !== '' ? token.label : id }
      }),
      generation: state.generation,
      page: pagePath,
      phase: state.phase,
      barrier: state.barrier,
      applyPending: state.applyPending,
      configErrors,
      configWarnings: state.configWarnings,
      registryWarnings: state.registryWarnings,
      snapshotWarnings: state.snapshotWarnings,
      lastError: state.lastError,
      retry: describeRetry(),
      /** Восстановление своих ref'ов (R2-b): ok — снимок возвращён и удалён, pending — повторится на старте. */
      restores: state.restores.slice(-10),
      pendingRestores: state.restores.filter((entry) => entry.status === 'pending').map((entry) => entry.ref),
      /** Гейт живых агентов (R7): candidates — видит реестр, gated — применён актуальный набор. */
      agentsReport: agentsGateReport(),
      /** Живость заголовочных токенов (verifyTool): token-ok | token-rejected | token-unknown. */
      verify: [...state.verify.values()].map((record) => ({
        server: record.server, status: record.status, httpCode: record.httpCode,
        reason: record.reason, login: record.login, checkedAt: record.checkedAt, tokenRef: record.tokenRef,
      })),
      tokenRejected: [...state.tokenRejected],
      journal: { file: logFile, bytes: journalBytes, lines: journalLines, maxBytes: journalMaxBytes },
      gateway: {
        baseUrl: gatewayBase(),
        registryError: state.registryError,
        envStatusError: state.envStatusError,
        keyHealthError: state.keyHealthError,
        registryAt: state.registryAt,
        registeredServers: [...state.registry.keys()],
        // Объявлено в конфиге плагина, но шлюз этого сервера активному ключу не выдаёт.
        configOnlyServers: configOnlyServers(),
      },
      servers,
      tokens,
      // Раздел «Промпты»: что предлагает экран (текст читается отдельным POST /api/prompts/item).
      prompts: await listPrompts(),
      models: {
        provider: modelState.provider,
        keyRef: modelState.keyRef,
        keyWritable: isOwnRef(modelState.keyRef),
        keyState: modelState.keyState,
        baseUrl: modelState.baseUrl,
        // Уровень размышлений, который маршрут объявляет при молчащем агенте (новая ручка конфига).
        reasoningEffort: String(cfg.defaultReasoningEffort || ''),
        // Последняя вынужденная подмена дефолтной модели (выбранной модели нет в правах ключа).
        defaultSwap: modelState.defaultSwap,
        allowed: modelState.known ? [...modelState.allowed] : null,
        degraded: modelState.degraded,
        error: modelState.error,
        fetchedAt: modelState.fetchedAt,
        // Ёмкости, которые шлюз сообщает не для всех моделей (max_input_tokens/max_output_tokens).
        limits: Object.fromEntries(modelState.limits),
        // Порог автокомпакта, который DSH посчитает для этих ёмкостей:
        // min(ratio·окно, окно − вывод − headroom) (dsh-compaction-basic/lib/index.js:132).
        // Диагностика: числа зависят от настроек compaction-basic в пресете агента.
        compaction: {
          headroomTokens: Number(cfg.compactionHeadroomTokens) || 0,
          thresholdRatio: Number(cfg.compactionThresholdRatio) || 0.8,
          effective: [...modelState.allowed].map((id) => {
            const entry = modelState.limits.get(id) || {}
            // Окно — из шлюза, а при молчании — объявленное плагином (defaultContextWindow).
            // Резерв вывода — только реально объявленный адаптеру (configuredMaxTokens), не умолчание.
            const contextWindow = entry.contextWindow ?? (Number(cfg.defaultContextWindow) || 0)
            const maxTokens = entry.maxTokens ?? 0
            const threshold = Math.floor(Math.min(
              contextWindow * (Number(cfg.compactionThresholdRatio) || 0.8),
              contextWindow - maxTokens - (Number(cfg.compactionHeadroomTokens) || 0),
            ))
            return { id, contextWindow, maxTokens, threshold }
          }),
        },
        // Маршрут, которым владеет плагин: чем живёт селектор моделей.
        route: {
          provider: gatewayRoute.providerId,
          installed: gatewayRoute.installed,
          api: 'openai-completions',
          models: gatewayRoute.installed && modelState.known ? modelState.allowed.size : 0,
        },
        current: currentSelection(),
      },
      missingGrants: activeGrant() === undefined
        ? []
        : [...activeGrant().servers.keys()].filter((name) => !state.registry.has(name) && !catalog.servers.has(name)),
      mounts: [...state.mounts.entries()].map((entry) => ({
        server: entry[0], status: entry[1].status, serverName: entry[1].serverName,
        error: entry[1].error, setupUrl: entry[1].setupUrl || '',
        mountedTools: registeredTools(entry[1].serverName).length,
      })),
    }
  }

  /**
   * Диагностика гейтов (доказательства приёмки).
   * @returns {Promise<object>} снимок для /api/diag.
   */
  const describeDiagnostics = async () => {
    const agents = []
    for (const record of state.agents.values()) {
      let visible = []
      try {
        visible = record.ctx.tools.schemas(record.scope).map((schema) => schema.name)
      } catch (error) {
        visible = ['<error: ' + messageOf(error) + '>']
      }
      agents.push({
        label: record.label,
        visibleMcp: visible.filter((toolName) => toolName.startsWith('mcp__')),
        visibleTotal: visible.length,
        denied: [...record.hidden],
      })
    }
    const globalTools = globalMcpToolNames()
    const llm = ctx.get('llm')
    return {
      activeToken: state.activeToken,
      phase: state.phase,
      barrier: state.barrier,
      applyPending: state.applyPending,
      generation: state.generation,
      lastError: state.lastError,
      retry: describeRetry(),
      snapshotWarnings: state.snapshotWarnings,
      restores: state.restores.slice(-10),
      pendingRestores: state.restores.filter((entry) => entry.status === 'pending').map((entry) => entry.ref),
      /** R7: agents.gated обязан совпадать с candidates; agents.list — поимённая картина по агентам. */
      agents: Object.assign(agentsGateReport(), { list: agents }),
      verify: [...state.verify.values()].map((record) => ({
        server: record.server, status: record.status, httpCode: record.httpCode,
        reason: record.reason, login: record.login, checkedAt: record.checkedAt, tokenRef: record.tokenRef,
      })),
      tokenRejected: [...state.tokenRejected],
      configErrors,
      gateway: {
        baseUrl: gatewayBase(),
        registryError: state.registryError,
        envStatusError: state.envStatusError,
        keyHealthError: state.keyHealthError,
        warnings: state.registryWarnings,
        registry: [...state.registry.values()].map((entry) => ({
          name: entry.name, alias: entry.alias, accessGroups: entry.accessGroups,
        })),
        envStatus: [...state.envStatus.entries()].map((entry) => ({
          server: entry[0], missingCount: entry[1].missingCount,
          required: entry[1].required, setupUrl: entry[1].setupUrl,
        })),
      },
      globalMcpTools: globalTools,
      allowedMcpTools: globalTools.filter((toolName) => toolAllowed(toolName)),
      deniedMcpTools: globalTools.filter((toolName) => isManagedTool(toolName) && !toolAllowed(toolName)),
      grants: [...state.grants.values()].map((grant) => ({
        server: grant.name, serverName: grant.serverName,
        tools: grant.all ? ['*'] : [...grant.tools],
      })),
      managedServers: [...state.everManaged],
      keyAllowedModels: modelState.known ? [...modelState.allowed] : null,
      // Ёмкости из шлюза (есть не у всех моделей): их получает маршрут плагина.
      keyModelLimits: Object.fromEntries(modelState.limits),
      route: {
        provider: gatewayRoute.providerId,
        installed: gatewayRoute.installed,
        api: 'openai-completions',
        models: gatewayRoute.installed && modelState.known ? modelState.allowed.size : 0,
      },
      keyState: modelState.keyState,
      keyRef: modelState.keyRef,
      keyError: modelState.error,
      modelsDegraded: modelState.degraded,
      currentDefaultModel: currentSelection(),
      liveProviders: llm && typeof llm.listProviders === 'function' ? llm.listProviders().map((provider) => provider.id) : [],
      liveCatalog: llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function'
        ? await Promise.all((llm.listProviders() || []).map(async (provider) => ({
          provider: provider.id,
          models: (await llm.listModels(provider.id)).map((model) => model.id),
        })))
        : [],
    }
  }

  /** Прочитать page.html рядом с плагином. */
  const htmlPage = async () => {
    try {
      return await readFile(new URL('./page.html', import.meta.url), 'utf8')
    } catch {
      return '<!doctype html><meta charset="utf-8"><title>dsh-mcp-access</title>'
        + '<h1>verme-gate</h1><p>page.html отсутствует; API: ' + pagePath + '/api/state</p>'
    }
  }

  /** POST /api/secret: записать (или снять) личный серверный токен (header-режим) и пересинхронизировать. */
  const handleSecret = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const server = resolveServer(String(body.server || ''))
      if (server === undefined) return json(res, 404, { error: 'unknown server "' + body.server + '"' })
      if (server.tokenHeader === '') return json(res, 400, { error: 'server "' + server.name + '" has no tokenHeader (gateway-mode creds live in LiteLLM)' })
      if (!isOwnRef(server.tokenRef)) return json(res, 400, { error: 'tokenRef "' + server.tokenRef + '" вне пространства ' + OWN_REF_PREFIX + '*' })
      const value = typeof body.value === 'string' ? body.value : ''
      if (value === '') {
        await ctx.credentials.unset(credentialRef(server.tokenRef))
        journal('secret cleared server=' + server.name + ' ref=' + server.tokenRef)
      } else {
        await ctx.credentials.set(credentialRef(server.tokenRef), value)
        journal('secret set server=' + server.name + ' ref=' + server.tokenRef + ' length=' + value.length)
      }
      // Значение личного токена заменено или снято: прежний вердикт относится к другому значению.
      invalidateVerify(server.name)
      await applyServers('secret-write', [server.name])
      if (value !== '') await verifyNow(server.name)
      return json(res, 200, Object.assign({ ok: true }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR secret: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/server-header: задать (value непустой) или снять (value пустой) заголовок, который
   * требует сам сервис. Имя приходит из записи шлюза, человек может его поправить; значение живёт
   * только в credential-store (NFR-002), в журнал попадают лишь имя и длина.
   */
  const handleServerHeader = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const server = resolveServer(String(body.server || ''))
      if (server === undefined) return json(res, 404, { error: 'unknown server "' + body.server + '"' })
      const name = String(body.name || '')
      if (!HEADER_NAME_PATTERN.test(name)) return json(res, 400, { error: 'invalid header name "' + name + '"' })
      const value = typeof body.value === 'string' ? body.value.trim() : ''
      const headers = await readServerHeaders(server.name)
      if (value === '') delete headers[name]
      else headers[name] = value
      await writeServerHeaders(server.name, headers)
      journal('server header ' + server.name + ' ' + (value === '' ? 'cleared ' : 'set ') + name
        + (value === '' ? '' : ' length=' + value.length))
      // Заголовок заменён или снят: прежний вердикт относится к другому значению — сбрасываем ДО
      // перемонтирования, иначе его удалит после свежей проверки mount-хук.
      invalidateVerify(server.name)
      await applyServers('server-header', [server.name])
      if (value !== '') await verifyNow(server.name)
      return json(res, 200, Object.assign({ ok: true }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR server-header: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * Общая часть записи личных env var (FR-020): id записи шлюза для сервера и активный ключ.
   * @param {string} serverName - имя сервера в шлюзе.
   * @returns {Promise<{serverId?: string, key?: string, error?: string}>} id/ключ либо ошибка.
   */
  const envVarTarget = async (serverName) => {
    const env = state.envStatus.get(serverName)
    const registryEntry = state.registry.get(serverName)
    const serverId = (env !== undefined && env.serverId !== '' ? env.serverId : '')
      || (registryEntry !== undefined ? registryEntry.serverId : '')
    if (serverId === '') {
      return { error: 'шлюз не назвал server_id для "' + serverName + '" — значение писать некуда' }
    }
    const token = activeGrant()
    const key = token !== undefined && token.keyRef !== '' ? await readSecret(token.keyRef) : ''
    if (key === '') return { error: 'нет активного токена: личное значение пишется ключом пользователя' }
    return { serverId, key }
  }

  /**
   * POST /api/env-var: записать личное значение переменной, которую требует сервер (FR-020).
   * Значение идёт прямо в шлюз (POST /v1/mcp/server/<id>/user-env-vars) ключом активного
   * токена — без админки LiteLLM и без хранения в плагине. Тело: {server, name, value}.
   */
  const handleEnvVar = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const server = resolveServer(String(body.server || ''))
      if (server === undefined) return json(res, 404, { error: 'unknown server "' + body.server + '"' })
      const name = String(body.name || '').trim()
      if (name === '') return json(res, 400, { error: 'пустое имя переменной' })
      const declared = (state.envStatus.get(server.name) || { required: [] }).required
        .map((item) => item.name)
      if (declared.length > 0 && declared.indexOf(name) === -1) {
        return json(res, 400, { error: 'сервер не объявляет переменную "' + name + '"' })
      }
      const value = typeof body.value === 'string' ? body.value.trim() : ''
      if (value === '') return json(res, 400, { error: 'пустое значение переменной' })
      const target = await envVarTarget(server.name)
      if (target.error !== undefined) return json(res, 400, { error: target.error })
      const answer = await gatewaySend('POST', '/v1/mcp/server/' + target.serverId + '/user-env-vars',
        target.key, { values: { [name]: value } })
      if (answer.error !== undefined) {
        journal('ERROR env-var ' + server.name + ' ' + name + ': ' + answer.error)
        return json(res, 502, { error: answer.error })
      }
      journal('env var ' + server.name + ' set ' + name + ' length=' + value.length)
      // Значение заменено — прежний вердикт и запрет тулзов относились к другому значению.
      // Кеш проверки не видит само значение (только его наличие), поэтому сбрасываем явно:
      // иначе новая запись получила бы статус прошлой.
      invalidateVerify(server.name)
      await applyServers('env-var', [server.name])
      await verifyNow(server.name)
      return json(res, 200, Object.assign({ ok: true }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR env-var: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/env-var-clear: снять личные значения переменных сервера (FR-020).
   * Шлюз умеет удалять только весь набор значений сервера, поэтому чистим целиком.
   * Тело: {server}.
   */
  const handleEnvVarClear = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const server = resolveServer(String(body.server || ''))
      if (server === undefined) return json(res, 404, { error: 'unknown server "' + body.server + '"' })
      const target = await envVarTarget(server.name)
      if (target.error !== undefined) return json(res, 400, { error: target.error })
      const answer = await gatewaySend('DELETE', '/v1/mcp/server/' + target.serverId + '/user-env-vars',
        target.key)
      if (answer.error !== undefined) {
        journal('ERROR env-var-clear ' + server.name + ': ' + answer.error)
        return json(res, 502, { error: answer.error })
      }
      journal('env var ' + server.name + ' cleared')
      // Значения больше нет: вердикт и запрет тулзов относятся к снятому значению. Сброс идёт ДО
      // применения, иначе settlePhase успевает показать degraded по уже недействительному вердикту.
      invalidateVerify(server.name)
      await applyServers('env-var-clear', [server.name])
      return json(res, 200, Object.assign({ ok: true }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR env-var-clear: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/verify: проверить личное значение сервера через его verifyTool.
   * Тело: {server?} — один сервер или все серверы с verifyTool. Режим не важен: header-режим
   * проверяется личным токеном, client-headers — сохранёнными заголовками, gateway — вызовом
   * через шлюз. Идемпотентна; при недоступном MCP отвечает token-unknown (таймаут verifyTimeoutMs).
   */
  const handleVerify = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const requestedName = typeof body.server === 'string' ? body.server : ''
      const targets = []
      if (requestedName !== '') {
        const server = resolveServer(requestedName)
        if (server === undefined) return json(res, 404, { error: 'unknown server "' + requestedName + '"' })
        if (verifyToolOf(server) === '') return json(res, 400, { error: 'server "' + server.name + '" has no probe tool — проверять нечего' })
        targets.push(server)
      } else {
        // Только серверы активного токена (реестр шлюза): сервер вне грантов отвечает 401 и
        // отравлял бы флаг token-rejected всему инстансу.
        for (const server of serverEntries()) {
          if (verifyToolOf(server) !== '') targets.push(server)
        }
      }
      const results = []
      for (const server of targets) results.push(await verifyServer(server, { force: true }))
      return json(res, 200, Object.assign({ ok: true, verify: results }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR verify: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /** POST /api/active: переключить активный токен живьём и персистить выбор. */
  const handleActive = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const tokenId = String(body.tokenId || '')
      if (!hasToken(tokenId)) return json(res, 404, { error: 'unknown token "' + tokenId + '"' })
      // R1: барьер поднимается ВНУТРИ очереди, до смены activeToken (окно «новый токен + старый allowlist»)
      await applyActiveToken('token-switch:' + tokenId, tokenId)
      journal('active token -> ' + tokenId)
      return json(res, 200, Object.assign({ ok: true }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR active: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/disconnect: снять доступ, не удаляя токен (в модели «одно подключение» это кнопка
   * «Отключить»): активного токена нет, серверы сняты, ключ провайдера убран, ключ токена остаётся.
   */
  const handleDisconnect = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const previous = state.activeToken
      if (previous !== '') {
        await applyActiveToken('disconnect:' + previous, '')
        journal('disconnect: active token "' + previous + '" снят с доступа (токен сохранён)')
      }
      return json(res, 200, Object.assign({ ok: true, disconnected: previous }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR disconnect: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /** POST /api/token-key: записать (или снять) LiteLLM-ключ токена доступа (write-only). */
  const handleTokenKey = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const tokenId = String(body.token || '')
      const token = hasToken(tokenId) ? catalog.tokens.get(tokenId) : undefined
      if (token === undefined) return json(res, 404, { error: 'unknown token "' + body.token + '"' })
      if (!isOwnRef(token.keyRef)) {
        return json(res, 400, { error: 'token "' + token.id + '": keyRef "' + (token.keyRef || '(пусто)') + '" вне пространства ' + OWN_REF_PREFIX + '* — запись запрещена' })
      }
      const value = typeof body.value === 'string' ? body.value : ''
      if (value === '') {
        await ctx.credentials.unset(credentialRef(token.keyRef))
        journal('token key cleared token=' + token.id + ' ref=' + token.keyRef)
      } else {
        await ctx.credentials.set(credentialRef(token.keyRef), value)
        journal('token key set token=' + token.id + ' ref=' + token.keyRef + ' length=' + value.length)
      }
      if (token.id === state.activeToken) await applyActiveToken('token-key-write')
      return json(res, 200, await describeState())
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR token-key: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * Проверить ключ LiteLLM, ничего не сохраняя: что шлюз разрешает этому ключу.
   * Ключ нигде не пишется и не журналируется — только счётчики.
   * @param {unknown} rawKey - вставленный ключ.
   * @returns {Promise<{servers?: object[], models?: string[], modelsError?: string, error?: string}>} права ключа либо ошибка.
   */
  const probeKey = async (rawKey) => {
    const key = String(rawKey || '').trim()
    if (key === '') return { error: 'вставьте ключ LiteLLM' }
    if (key.length > 200 || /\s/.test(key)) return { error: 'это не похоже на ключ LiteLLM: в ключе нет пробелов и переводов строк' }
    const registry = await discoverRegistry(key)
    if (registry.error !== undefined) {
      return { error: 'шлюз не принял ключ (' + registry.error + '): проверьте, что это ключ LiteLLM этого шлюза и он не отозван' }
    }
    const discovery = await discoverModels(key)
    return {
      servers: registry.servers.map((server) => ({ name: server.name, alias: server.alias, accessGroups: server.accessGroups })),
      models: discovery.error === undefined ? discovery.ids : [],
      modelsError: discovery.error === undefined ? '' : discovery.error,
    }
  }

  /** POST /api/key-probe: показать, что даёт вставленный ключ (серверы и модели), без сохранения. */
  const handleKeyProbe = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const probe = await probeKey(body.key)
      if (probe.error !== undefined) return json(res, 400, { error: probe.error })
      journal('key probe: servers=' + probe.servers.length + ' models=' + probe.models.length)
      return json(res, 200, Object.assign({ ok: true }, probe))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR key-probe: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/token-connect: один шаг — вставили ключ, токен создан, ключ записан, токен активен.
   * Название необязательно: по умолчанию «Ключ …<хвост ключа>».
   */
  const handleTokenConnect = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const probe = await probeKey(body.key)
      if (probe.error !== undefined) return json(res, 400, { error: probe.error })
      const key = String(body.key).trim()
      const given = String(body.label || '').trim()
      // Тот же ключ уже сохранён у токена экрана — не плодим второй, просто включаем доступ.
      for (const known of uiTokens.values()) {
        const stored = await readSecret(known.keyRef)
        if (stored === '' || stored !== key) continue
        if (body.activate !== false) {
          await applyActiveToken('token-connect-reuse:' + known.id, known.id)
        }
        journal('token connected (reuse) token=' + known.id + ' servers(allowed by key)=' + probe.servers.length
          + ' models=' + probe.models.length + ' ref=' + known.keyRef)
        return json(res, 200, Object.assign(
          { ok: true, tokenId: known.id, reused: true, probe: { servers: probe.servers, models: probe.models } },
          await describeState(),
        ))
      }
      const label = (given !== '' ? given : 'Ключ …' + key.slice(-4)).slice(0, 80)
      let id = slugTokenId(label)
      if (!TOKEN_ID_PATTERN.test(id)) id = 'key-' + Date.now().toString(36)
      id = uniqueTokenId(id)
      const token = {
        id,
        label,
        servers: new Map(),
        keyRef: tokenKeyRef(id),
        models: [],
        group: '',
        source: 'ui',
      }
      await ctx.credentials.set(credentialRef(token.keyRef), key)
      uiTokens.set(id, token)
      catalog.tokens.set(id, token)
      await saveStateDoc()
      journal('token connected token=' + id + ' label=' + label + ' servers(allowed by key)=' + probe.servers.length
        + ' models=' + probe.models.length + ' ref=' + token.keyRef)
      if (body.activate !== false) await applyActiveToken('token-connect:' + id, id)
      return json(res, 200, Object.assign(
        { ok: true, tokenId: id, probe: { servers: probe.servers, models: probe.models } },
        await describeState(),
      ))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR token-connect: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/token-add: создать токен доступа через экран.
   * Токен живёт в stateFile (не в конфиге оператора); ключ LiteLLM выдаётся ему отдельно
   * через /api/token-key. Гранты — только по серверам, описанным в конфиге плагина.
   */
  const handleTokenAdd = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const label = String(body.label || '').trim()
      if (label === '' || label.length > 80) {
        return json(res, 400, { error: 'название токена обязательно и короче 80 символов' })
      }
      // Идентификатор — внутреннее имя (из него собирается ref ключа и запись в stateFile): человек его не вводит.
      const requestedId = String(body.id || '').trim().toLowerCase()
      let id = requestedId !== '' ? requestedId : slugTokenId(label)
      if (!TOKEN_ID_PATTERN.test(id)) {
        return json(res, 400, { error: 'из названия не выходит идентификатор: добавьте латинские буквы в название' })
      }
      if (catalog.tokens.has(id)) {
        if (requestedId !== '') return json(res, 409, { error: 'токен "' + id + '" уже существует' })
        id = uniqueTokenId(id)
      }
      // Список серверов диктует ключ LiteLLM; поле servers — только необязательное локальное сужение.
      const grants = new Map()
      const requested = Array.isArray(body.servers) ? body.servers : []
      for (const rawName of requested) {
        const serverName = String(rawName || '')
        if (serverName === '') continue
        if (!catalog.servers.has(serverName)) {
          return json(res, 400, { error: 'сервер "' + serverName + '" не описан в конфиге плагина' })
        }
        grants.set(serverName, { tools: [], all: true })
      }
      const token = {
        id,
        label,
        servers: grants,
        keyRef: tokenKeyRef(id),
        models: [],
        group: '',
        source: 'ui',
      }
      uiTokens.set(id, token)
      catalog.tokens.set(id, token)
      await saveStateDoc()
      journal('token added token=' + id + ' label=' + label
        + ' servers=' + (grants.size === 0 ? '(по правам ключа)' : [...grants.keys()].join(',')) + ' ref=' + token.keyRef)
      return json(res, 200, Object.assign({ ok: true, tokenId: id }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR token-add: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /**
   * POST /api/token-remove: убрать токен с экрана.
   * Токен экрана удаляется вместе со своим ключом; токен конфига только скрывается (конфиг не переписываем).
   * Активный токен не удаляется: сначала переключите доступ на другой.
   */
  const handleTokenRemove = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const tokenId = String(body.token || '')
      if (!catalog.tokens.has(tokenId)) return json(res, 404, { error: 'unknown token "' + tokenId + '"' })
      const isActive = tokenId === state.activeToken
      const remaining = visibleTokens().filter((token) => token.id !== tokenId)
      // Последний активный токен удалять можно: это и есть «отключить доступ» (серверы снимаются,
      // ключ провайдера снимается). Пока есть другой видимый токен — сначала переключение (409).
      if (isActive && remaining.length > 0) {
        return json(res, 409, { error: 'токен "' + tokenId + '" активен: сначала примените другой токен, потом удаляйте' })
      }
      const uiToken = uiTokens.get(tokenId)
      if (uiToken !== undefined) {
        if (isOwnRef(uiToken.keyRef)) {
          await ctx.credentials.unset(credentialRef(uiToken.keyRef))
          journal('token removed: unset ' + uiToken.keyRef)
        }
        uiTokens.delete(tokenId)
        catalog.tokens.delete(tokenId)
      } else {
        hiddenTokens.add(tokenId)
      }
      await saveStateDoc()
      journal('token removed token=' + tokenId + ' kind=' + (uiToken !== undefined ? 'ui' : 'hidden')
        + (isActive ? ' (был активным, токенов больше нет: доступ выключен)' : ''))
      if (isActive) await applyActiveToken('token-remove:' + tokenId, '')
      return json(res, 200, Object.assign({
        ok: true,
        removed: uiToken !== undefined ? 'ui' : 'hidden',
        accessDisabled: isActive,
      }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR token-remove: ' + message)
      return json(res, 500, { error: message })
    }
  }

  /** POST /api/token-restore: вернуть на экран скрытый токен конфига. */
  const handleTokenRestore = async (req, res) => {
    const body = await readJsonBody(req, res)
    if (body === null) return
    try {
      const tokenId = String(body.token || '')
      if (!catalog.tokens.has(tokenId)) return json(res, 404, { error: 'unknown token "' + tokenId + '"' })
      if (!hiddenTokens.has(tokenId)) return json(res, 200, Object.assign({ ok: true }, await describeState()))
      hiddenTokens.delete(tokenId)
      await saveStateDoc()
      journal('token restored token=' + tokenId)
      return json(res, 200, Object.assign({ ok: true }, await describeState()))
    } catch (error) {
      const message = messageOf(error)
      journal('ERROR token-restore: ' + message)
      return json(res, 500, { error: message })
    }
  }

  const routes = []
  /**
   * Зарегистрировать exact-route с периметром auth и проверкой метода.
   * @param {string} path - путь.
   * @param {string} method - разрешённый метод.
   * @param {(req: object, res: object) => Promise<void>} handler - обработчик.
   */
  const register = (path, method, handler) => {
    routes.push(ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== method) {
          res.setHeader('allow', method)
          return json(res, 405, { error: method + ' only' })
        }
        try {
          await handler(req, res)
        } catch (error) {
          journal('ERROR route ' + path + ': ' + messageOf(error))
          json(res, 500, { error: messageOf(error) })
        }
      },
    }))
  }

  if (routesEnabled) {
    register(pagePath, 'GET', async (req, res) => {
      const html = await htmlPage()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      })
      res.end(html)
    })
    register(pagePath + '/api/state', 'GET', async (req, res) => json(res, 200, await describeState()))
    // Раздел «Промпты»: список markdown-инструкций из cfg.promptsDir и выдача текста по id.
    // Отправкой в сессию занимается клиент (у него есть композер), хост только отдаёт текст.
    register(pagePath + '/api/prompts', 'GET', async (req, res) => json(res, 200, await listPrompts()))
    register(pagePath + '/api/prompts/item', 'POST', async (req, res) => {
      const body = await readJsonBody(req, res)
      if (body === null) return
      const prompt = await readPrompt(body.id)
      if (prompt.error !== undefined) return json(res, 400, prompt)
      journal('prompts: выдан "' + prompt.id + '" (' + prompt.text.length + ' символов)')
      json(res, 200, prompt)
    })
    // Деньги активного ключа для чипа под композером: тот же расчёт, что в /api/state.budget,
    // но отдельным маршрутом — чип живёт в разговоре, вне экрана настроек.
    register(pagePath + '/api/budget', 'GET', async (req, res) => {
      const token = catalog.tokens.get(state.activeToken)
      json(res, 200, token === undefined
        ? { tokenId: '', key: null, user: null, team: null, today: null, error: 'активный токен не выбран', fetchedAt: Date.now() }
        : await describeBudget(token))
    })
    register(pagePath + '/api/diag', 'GET', async (req, res) => json(res, 200, await describeDiagnostics()))
    register(pagePath + '/api/refresh', 'POST', async (req, res) => {
      if (await readJsonBody(req, res) === null) return
      // ручной refresh сохраняется и сбрасывает таймер авто-ретрая (R3)
      resetRetry()
      await applyActiveToken('manual-refresh')
      json(res, 200, Object.assign({ ok: true }, await describeState()))
    })
    register(pagePath + '/api/secret', 'POST', handleSecret)
    register(pagePath + '/api/server-header', 'POST', handleServerHeader)
    register(pagePath + '/api/env-var', 'POST', handleEnvVar)
    register(pagePath + '/api/env-var-clear', 'POST', handleEnvVarClear)
    register(pagePath + '/api/verify', 'POST', handleVerify)
    register(pagePath + '/api/active', 'POST', handleActive)
    register(pagePath + '/api/disconnect', 'POST', handleDisconnect)
  register(pagePath + '/api/token-key', 'POST', handleTokenKey)
    register(pagePath + '/api/key-probe', 'POST', handleKeyProbe)
  register(pagePath + '/api/token-connect', 'POST', handleTokenConnect)
  register(pagePath + '/api/token-add', 'POST', handleTokenAdd)
    register(pagePath + '/api/token-remove', 'POST', handleTokenRemove)
    register(pagePath + '/api/token-restore', 'POST', handleTokenRestore)
    ctx.effect(() => () => {
      for (const disposer of routes) {
        try {
          disposer()
        } catch {
          /* already removed */
        }
      }
    }, 'dsh-mcp-access.routes')
  } else {
    log('error', 'маршруты не подняты: ' + configErrors.join('; '))
  }

  /* ─────────────────────── подписки ─────────────────────── */

  // Гейт ставится в scope каждого агента: tools.restrict() из root-ctx запрещён
  // (PKG/dsh-tools/lib/index.js:2993), поэтому ловим agent/created.
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (agent === undefined) return
    const record = registerAgent(agent, 'agent/created')
    if (record === undefined) return
    try {
      reconcileGates(record)
    } catch (error) {
      log('warn', 'gate on agent/created: ' + messageOf(error))
    }
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (agent === undefined) return
    const record = state.agents.get(agent)
    if (record !== undefined) releaseAgentLayers(record)
    state.agents.delete(agent)
  })

  // MCP-тулзы появляются асинхронно (сервер может подключиться позже агента) — пересчитываем запреты.
  ctx.on('tools/change', () => {
    // Статус монтирования мог устареть: фибер иногда подключается уже после первой попытки.
    recalcMounts()
    applyAgentGates()
  })

  // R7: агенты, жившие до старта/перезагрузки плагина, не получат agent/created — подбираем их сразу,
  // не дожидаясь первого tools/change: на сценарии установки (плагин включают на живом инстансе)
  // иначе их restrict-слои не пересчитываются и вызов доходит до MCP.
  try {
    adoptLiveAgents('startup-enumeration')
    applyAgentGates()
  } catch (error) {
    log('warn', 'startup agent enumeration: ' + messageOf(error))
    journal('ERROR startup agents: ' + messageOf(error))
  }

  /* ─────────────────────── старт ─────────────────────── */

  installModelGate()

  if (cfg.activeToken !== '' && catalog.tokens.has(cfg.activeToken)) state.activeToken = cfg.activeToken

  for (const error of configErrors) {
    log('error', error)
    journal('ERROR config: ' + error)
  }
  for (const warning of configWarnings) journal('WARN config: ' + warning)

  const startup = (async () => {
    // Свой маршрут поднимаем ДО первого опроса каталога: иначе ensureDefaultModel и селектор
    // успеют увидеть модели из патча, а не права ключа.
    await installGatewayRoute()
    await initJournalSize()
    const persisted = await loadStateDoc()
    for (const token of persisted.tokens) {
      uiTokens.set(token.id, token)
      catalog.tokens.set(token.id, token)
    }
    for (const id of persisted.hidden) hiddenTokens.add(id)
    // Состав серверов из прошлого запуска: если токена нет, экран покажет строки с причиной.
    if (Array.isArray(persisted.serverNames)) state.lastServerNames = [...persisted.serverNames]
    if (persisted.activeToken !== '' && hasToken(persisted.activeToken)) state.activeToken = persisted.activeToken
    else if (persisted.activeToken !== '') {
      log('warn', 'persisted activeToken "' + persisted.activeToken + '" недоступен (нет в конфиге или скрыт) — остаётся "'
        + state.activeToken + '"')
    }
    // R2-b: восстановление из durable-снимка имеет приоритет над захватом ref'а ключом токена.
    try {
      await completePendingRestore()
    } catch (error) {
      log('warn', 'pending restore: ' + messageOf(error))
      journal('ERROR restore pending: ' + messageOf(error))
    }
    await applyActiveToken('startup')
    startModelRefresh()
    journal('ready token=' + state.activeToken + ' phase=' + state.phase)
    log('info', 'ready: token=' + state.activeToken
      + ' phase=' + state.phase
      + ' registry=' + state.registry.size
      + ' mounts=' + [...state.mounts.values()].filter((record) => record.status === 'mounted' || record.status === 'starting').length
      + ' keyState=' + modelState.keyState
      + ' models=' + (modelState.known ? modelState.allowed.size : 'unknown')
      + ' page=' + (routesEnabled ? pagePath : '(disabled)'))
  })()

  /**
   * Лёгкое обновление модельной части: ключ → свой ref, каталог → GET /v1/models, дефолтная модель.
   * НЕ поднимает барьер, не перемонтирует MCP-серверы и не гоняет адаптеры: каталог читается
   * маршрутом на каждый вызов (getModels), поэтому достаточно обновить modelState.
   * Раньше авто-обновление шло через полный applyActiveToken и задевало монтирования.
   * @param {string} reason - метка для журнала.
   * @returns {Promise<void>} завершение обновления.
   */
  const refreshModelCatalog = (reason) => serialise(async () => {
    const started = Date.now()
    try {
      await applyModelAccess(state.activeToken)
    } catch (error) {
      journal('ERROR models refresh (' + reason + '): ' + messageOf(error))
    }
    try {
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      log('warn', 'emit llm/adapters-updated: ' + messageOf(error))
    }
    journal('models refresh (' + reason + ') models=' + (modelState.known ? modelState.allowed.size : 'unknown')
      + ' ms=' + (Date.now() - started))
  })

  /**
   * Периодическое перечитывание каталога. Права ключа меняются на шлюзе без нашего участия
   * (админ отозвал модели) — без таймера селектор показывал бы старый набор до следующего
   * события (смена токена, запись ключа, ручное «Обновить», рестарт).
   * Интервал — cfg.modelRefreshMs (0 выключает). Тик планируется ПОСЛЕ завершения предыдущего
   * (цепочка setTimeout), а не глушится проверкой «прошло ли уже N мс»: раньше из-за этой проверки
   * фактический интервал был вдвое больше объявленного (300000 → 10 минут).
   */
  const startModelRefresh = () => {
    const every = Number(cfg.modelRefreshMs) || 0
    if (!modelSyncEnabled || every <= 0) {
      journal('models: auto-refresh disabled (modelRefreshMs=' + String(cfg.modelRefreshMs) + ')')
      return
    }
    const period = Math.max(30000, every)
    let timer = null
    let stopped = false
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(async () => {
        if (!modelState.known || state.applyPending > 0) {
          schedule()
          return
        }
        try {
          await refreshModelCatalog('auto-refresh')
        } catch (error) {
          journal('ERROR models: auto-refresh: ' + messageOf(error))
        }
        schedule()
      }, period)
    }
    schedule()
    ctx.effect(() => () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    }, 'verme-gate.modelRefresh')
    journal('models: auto-refresh every ' + Math.round(period / 1000) + 's (light path: каталог без MCP-применения)')
  }

  /** Выгрузка плагина (HMR/удаление/остановка процесса): снять гейты, монтирования и вернуть ref'ы. */
  ctx.effect(() => () => {
    // Сначала снимаем барьер и запреты, чтобы агенты не остались с «висящими» слоями чужого поколения.
    clearRetry()
    state.barrier = false
    for (const record of state.agents.values()) releaseAgentLayers(record)
    state.agents.clear()
    const cleanup = (async () => {
      try {
        await applyChain
      } catch {
        /* очередь могла упасть — не мешаем выгрузке */
      }
      // R2-b: ref'ы возвращаем ПЕРВЫМИ — credential-store на этой фазе уже может быть закрыт,
      // поэтому восстановление идёт через аварийную запись в файл store (writeOwnRef/emergencyCredentialWrite).
      await restoreCredentialSnapshots('dispose')
      for (const serverName of [...state.mounts.keys()]) await unmount(serverName)
      installDefaultSubstitute(null)
      journal('plugin disposed')
      await journalFlush()
    })()
    return cleanup
  }, 'dsh-mcp-access.lifecycle')

  startup.catch((error) => {
    state.lastError = messageOf(error)
    state.phase = 'degraded'
    log('warn', 'startup: ' + state.lastError)
    journal('ERROR startup: ' + state.lastError)
  })
}
