/**
 * selftest — оффлайн-проверки плагина verme-gate: контракт модуля, схема конфига,
 * нормализация конфига и наличие страницы. Живой хост не требуется.
 *
 * Запуск: node selftest.mjs  (или npm test в каталоге плагина)
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const here = new URL('./', import.meta.url)
let failures = 0
/**
 * Проверить утверждение.
 * @param {string} name - что проверяем.
 * @param {boolean} ok - результат.
 * @param {string} [detail] - подробность при провале.
 */
const check = (name, ok, detail) => {
  if (ok) {
    console.log('ok   ' + name)
    return
  }
  failures += 1
  console.log('FAIL ' + name + (detail ? ' — ' + detail : ''))
}

const module_ = await import(pathToFileURL(new URL('index.js', here).pathname).href)
check('модуль экспортирует контракт плагина',
  typeof module_.name === 'string' && typeof module_.apply === 'function' && module_.Config !== undefined,
  'name=' + module_.name + ' apply=' + typeof module_.apply)
check('имя плагина = verme-gate', module_.name === 'verme-gate', String(module_.name))
check('inject содержит tools/credentials/webServer/llm',
  Array.isArray(module_.inject) && ['tools', 'credentials', 'webServer', 'llm'].every((key) => module_.inject.includes(key)),
  JSON.stringify(module_.inject))

const sample = {
  pagePath: '/verme-gate',
  gatewayBaseUrl: 'https://litellm.example.com',
  llmProvider: 'dshlab',
  llmSecretRef: 'MCP_ACCESS_LLM_KEY',
  llmBaseUrl: 'https://litellm.example.com/v1',
  servers: [
    { name: 'redmine_hdr', label: 'PDM header-режим', tokenHeader: 'X-Redmine-User-Key', verifyTool: 'redmine_hdr-redmine_whoami' },
    { name: 'sql', label: 'SQL read-only', toolAllow: ['list_databases'] },
  ],
  tokens: [
    { id: 'pdm-reader', keyRef: 'MCP_ACCESS_PDM_READER_LITELLM_KEY', servers: [{ server: 'redmine_hdr', tools: [] }, { server: 'sql', tools: ['list_databases'] }] },
    { id: 'data-qa', keyRef: 'MCP_ACCESS_DATA_QA_LITELLM_KEY', servers: [{ server: 'testy' }], group: '', source: 'manual' },
  ],
}
let parsed
try {
  parsed = module_.Config(sample)
  check('Config принимает конфиг шлюзовых серверов (name/tokenHeader/toolAllow)', true)
} catch (error) {
  check('Config принимает конфиг шлюзовых серверов (name/tokenHeader/toolAllow)', false, String(error && error.message ? error.message : error))
}
if (parsed !== undefined) {
  check('в конфиге нет собственных грантов моделей по умолчанию (источник правды — ключ)',
    parsed.tokens.every((token) => token.models.length === 0),
    JSON.stringify(parsed.tokens.map((token) => token.models)))
  check('tokenRequired по умолчанию true', parsed.servers.every((server) => server.tokenRequired === true))
  check('дефолт pagePath применяется', parsed.pagePath === '/verme-gate', parsed.pagePath)
  check('дефолт gatewayBaseUrl применяется',
    parsed.gatewayBaseUrl === 'https://litellm.example.com', parsed.gatewayBaseUrl)
  check('modelDiscoveryTimeoutMs по умолчанию 20000', parsed.modelDiscoveryTimeoutMs === 20000, String(parsed.modelDiscoveryTimeoutMs))
  check('R3: паузы авто-ретрая по умолчанию 1/3/9 с',
    JSON.stringify(parsed.retryDelaysMs) === JSON.stringify([1000, 3000, 9000]), JSON.stringify(parsed.retryDelaysMs))
  check('R3: фоновый повтор раз в 5 минут', parsed.retryBackgroundMs === 300000, String(parsed.retryBackgroundMs))
  check('task-11: verifyTool сервера проходит схему', parsed.servers[0].verifyTool === 'redmine_hdr-redmine_whoami',
    String(parsed.servers[0].verifyTool))
  check('task-11: verifyTool по умолчанию пуст (проверка не выполняется)',
    parsed.servers[1].verifyTool === '', String(parsed.servers[1].verifyTool))
  check('task-11: таймаут проверки 10 с и кеш 5 мин по умолчанию',
    parsed.verifyTimeoutMs === 10000 && parsed.verifyTtlMs === 300000,
    String(parsed.verifyTimeoutMs) + '/' + String(parsed.verifyTtlMs))
  check('source токена по умолчанию manual (FR-002a)', parsed.tokens.every((token) => token.source === 'manual'))
  check('в схеме сервера НЕТ stdio-полей (скоуп: только MCP за шлюзом)',
    ['transport', 'command', 'args', 'env', 'tokenEnv', 'cwd'].every((key) => !(key in parsed.servers[0])),
    JSON.stringify(Object.keys(parsed.servers[0])))
}

const page = await readFile(new URL('page.html', here), 'utf8')
check('page.html на месте и непустая', page.length > 3000, 'bytes=' + page.length)
check('page.html не содержит опасных шаблонных вставок сервера', !page.includes('__TOKEN__'))
check('page.html имеет write-only поля токенов', page.includes('type="password"') && page.includes('/api/secret') && page.includes('/api/token-key'))
check('page.html показывает setup_url и is_set (gateway-режим FR-013b)',
  page.includes('setupUrl') && page.includes('isSet'))
check('page.html показывает ошибки конфига и деградацию каталога', page.includes('configErrors') && page.includes('degraded'))
check('page.html знает статус key-error (битый ключ)', page.includes('key-error'))
check('task-11: page.html показывает «токен не принят» и ручку проверки',
  page.includes('токен НЕ принят') && page.includes('token-rejected') && page.includes('data-action="verify"') && page.includes('/api/verify'))
check('task-11: page.html различает token-ok / token-unknown',
  page.includes('token-ok') && page.includes('token-unknown') && page.includes('токен принят'))
check('page.html не отдаёт секреты: только «задан/не задан»', !page.includes('tokenValue') && !page.includes('keyValue'))

const source = await readFile(new URL('index.js', here), 'utf8')
check('P1-1: ручки закрыты ctx.connection.requestRejection', source.includes('requestRejection')
  && source.includes("inject = ['tools', 'llm', 'credentials', 'webServer', 'connection']"))
check('P1-1: POST требует application/json', source.includes("startsWith('application/json')") && source.includes('415'))
check('P1-1: мутации только POST (405 на прочие)', source.includes('405'))
check('P1-2: свой неймспейс credential-ref', source.includes("OWN_REF_PREFIX = 'MCP_ACCESS_'") && source.includes('isOwnRef'))
check('P1-2: снимок и восстановление ref на dispose',
  source.includes('snapshotCredential') && source.includes('restoreCredentialSnapshots'))
check('P1-3: барьер deny-all в двухфазном применении',
  source.includes('state.barrier = true') && source.includes('state.barrier = false') && source.includes('unmountAll'))
check('P1-4: применения сериализованы очередью', source.includes('const serialise = (task)') && source.includes('applyChain'))
check('P1-4: tmp-имя состояния уникально (uuid)', source.includes('randomUUID()') && !/stateFile + '\.tmp-' + process\.pid/.test(source))
check('F9: журнал ротируется по размеру', source.includes('journalMaxBytes') && source.includes(".1'"))
check('F11: нет хрупкого сравнения fiber.state === 3', !source.includes('fiber.state === 3'))
check('F3/F7: фолбэк каталога и запрет монтирования при битом ключе',
  source.includes('keyHealthError') && source.includes('degraded'))
check('F5/P2: причина отказа видна в состоянии (markSkipped на ошибке ключа/реестра)',
  source.includes("for (const serverName of affected) skipKnown(serverName, 'key-error', registry.error)")
  && source.includes('const skipKnown = (serverName, status, reason) =>')
  && source.includes("skipKnown(serverName, skipStatus, state.registryError)")
  && source.includes("markSkipped(server, 'key-error', 'ключ не подтвердился"))
check('P2: фаза starting, пока идут монтирования (settlePhase)', source.includes('const settlePhase') && source.includes("'starting'"))
check('P1-1: мутации отвечают ok=true', (source.match(/Object\.assign\(\{ ok: true \}/g) || []).length >= 2)
check('R1: барьер до смены activeToken (токен применяется внутри очереди)',
  source.includes("applyActiveToken('token-switch:' + tokenId, tokenId)")
  && source.includes('const applyNow = async (reason, nextTokenId, only)')
  && source.includes('state.activeToken = nextTokenId'))
check('R2: durable-снимок ref-а в credential-store, а не только в памяти',
  source.includes("const SNAPSHOT_SUFFIX = '_SNAPSHOT'")
  && source.includes('SNAPSHOT_UNKNOWN') && source.includes('snapshotRefOf')
  && source.includes('credentialRef(snapshotRef)'))
check('R2: постановка на подменённый ref даёт предупреждение',
  source.includes('snapshotWarnings') && source.includes('поставлен на подменённый ref'))
check('R3: backoff+jitter, nextRetryAt в диагностике',
  source.includes('const scheduleRetry') && source.includes('0.85 + Math.random() * 0.3')
  && source.includes('nextRetryAt') && source.includes('settleRetry()'))
check('R3: ручной refresh сбрасывает таймер, dispose снимает',
  source.includes('resetRetry()') && source.includes('clearRetry()'))
check('task-11: verifyTool в схеме и в синтезированных серверах',
  source.includes("verifyTool: z.string().default('')") && (source.match(/verifyTool: ''/g) || []).length >= 1)
check('task-11: три статуса живости токена объявлены',
  source.includes("'token-ok'") && source.includes("'token-rejected'") && source.includes("'token-unknown'"))
check('task-11: проверка идёт вызовом MCP-тулза verifyTool (initialize + tools/call)',
  source.includes('const callVerifyTool') && source.includes("method: 'initialize'") && source.includes("method: 'tools/call'")
  && source.includes('server.verifyTool'))
check('task-11: 401/403 распознаются и в теле успешного HTTP (status_code)',
  source.includes('statusOfResult') && source.includes('logical.code === 401 || logical.code === 403'))
check('task-11: таймаут проверки ограничен (AbortController + verifyTimeoutMs)',
  source.includes('controller.abort()') && source.includes('cfg.verifyTimeoutMs'))
check('task-11: результат кешируется по отпечатку токена и сбрасывается force',
  source.includes('const fingerprint') && source.includes('cfg.verifyTtlMs') && source.includes('options.force === true'))
check('task-11: token-rejected -> фаза degraded (как key-error)',
  source.includes('state.tokenRejected.size > 0') && source.includes('token-error: токен не принят'))
check('task-11: тулзы сервера с отвергнутым токеном запрещены агентам (fail-closed)',
  source.includes('state.tokenRejected.has(grant.serverName)'))
check('task-11: ручка POST /api/verify зарегистрирована',
  source.includes('const handleVerify') && source.includes("register(pagePath + '/api/verify', 'POST', handleVerify)"))
check('task-11: значения токенов не попадают в журнал (только сервер/статус/код/логин)',
  !/journal\([^\n]*personal/.test(source) && source.includes("journal('verify ' + server.name + ' ' + status + ' httpCode='"))
check('task-13: снимки ref-ов восстанавливаются при остановке до снятия монтирований',
  source.includes("restoreCredentialSnapshots('dispose')")
  && source.indexOf("restoreCredentialSnapshots('dispose')") < source.indexOf("journal('plugin disposed')"))
check('task-13: durable pending restore выполняется на старте до захвата ref',
  source.includes('const completePendingRestore')
  && source.indexOf('await completePendingRestore()') < source.indexOf("await applyActiveToken('startup')"))
check('task-13: отказ записи восстанавливается аварийной записью в файл store',
  source.includes('const emergencyCredentialWrite') && source.includes('const writeOwnRef'))
check('task-13: снимок удаляется только после подтверждённой записи ref',
  source.includes('const dropSnapshot') && source.includes("if (await emergencyCredentialWrite(ref, value)) return { ok: true, via: 'file', error: serviceError }"))
check('task-13: статусы восстановления ok/pending/... объявлены и видны в /api/state',
  source.includes("status: 'pending'") && source.includes('pendingRestores: state.restores.filter') && source.includes('restores: state.restores.slice(-10)'))
check('task-13: R7 — живые агенты перечисляются на старте и в проходе гейта',
  source.includes("adoptLiveAgents('startup-enumeration')") && source.includes("adoptLiveAgents('apply')"))
check('task-13: R7 — /api/diag показывает candidates/gated/ungated и поимённый список',
  source.includes('const agentsGateReport') && source.includes('agents: Object.assign(agentsGateReport(), { list: agents })'))
check('task-13: R7 — гейт агента пересчитывается, а не инкрементится',
  source.includes('const desiredDenied') && source.includes('const reconcileGates') && source.includes('releaseAgentLayers(record)'))

// FR-016/FR-017: подключение ключом с предварительной проверкой прав и одно подключение на экземпляр.
check('FR-016: проверка ключа до сохранения (POST /api/key-probe)',
  source.includes('const handleKeyProbe') && source.includes("register(pagePath + '/api/key-probe', 'POST', handleKeyProbe)"))
check('FR-016a: проверка ключа ничего не сохраняет (journal только со счётчиками)',
  !/journal\([^\n]*body\.key/.test(source) && source.includes("journal('key probe: servers='"))
check('FR-016: подключение ключом одной ручкой (POST /api/token-connect)',
  source.includes('const handleTokenConnect') && source.includes("register(pagePath + '/api/token-connect', 'POST', handleTokenConnect)"))
check('FR-017: тот же ключ переиспользует подключение, а не плодит токены',
  source.includes("applyActiveToken('token-connect-reuse:' + known.id, known.id)"))
check('FR-017: отключение доступа без удаления ключа (POST /api/disconnect)',
  source.includes('const handleDisconnect') && source.includes("register(pagePath + '/api/disconnect', 'POST', handleDisconnect)")
  && source.includes("await applyActiveToken('disconnect:' + previous, '')"))
check('FR-017: удаление последнего токена выключает доступ, а не блокируется',
  source.includes('accessDisabled: isActive') && source.includes('remaining.length > 0'))
check('FR-017: статус no-active-token объявлен (сервер без подключения)',
  source.includes("'no-active-token'") && source.includes("skipStatus = token === undefined ? 'no-active-token' : 'key-error'"))
check('FR-017: устаревшие статусы серверов не переживают новое применение',
  source.includes('if (record.fiber === undefined) state.mounts.delete(serverName)'))
check('FR-017: сервер с личным ключом без ключа помечен no-token, а не «не подключён»',
  source.includes("if (personal === '') markSkipped(server, 'no-token', 'token not set in credential store (' + server.tokenRef + ')')"))

const client = await readFile(new URL('client/index.cjs', here), 'utf8')
check('FR-017: вкладки — Доступ / Серверы и инструменты / Дополнительно',
  client.includes("{ id: 'servers', label: 'Серверы и инструменты' }")
  && !client.includes("{ id: 'keys', label: 'Ключи' }"))
check('FR-017: до подключения списка инструментов нет (пустое состояние)',
  client.includes('Список появится после подключения') && client.includes('Перейти к подключению'))
check('FR-015: токены переключаются и удаляются из экрана (список токенов на вкладке)',
  client.includes("'/active'") && client.includes('Сделать активным')
  && client.includes("'/token-remove'"))
check('FR-017: кнопки подключения — ключ или SSO, замена ключа и отключение',
  client.includes('Подключить по ключу') && client.includes('Войти через SSO')
  && client.includes('Заменить ключ') && client.includes("'/disconnect'"))
check('FR-017: удаление подключения вынесено в «Дополнительно»',
  client.includes("h(RemoveTokenDialog") && client.includes('Удалить токен и ключ'))
check('FR-017d: длинный список моделей не растягивает экран',
  client.includes('Перечень моделей — на вкладке «Серверы и инструменты»')
  && client.includes("'Показать все ' + models.length + ' моделей'")
  && client.includes('dshMcpList dshMcpScroll')
  && client.includes('servers.slice(0, 8)'))
const serverEntriesBody = (() => {
  const from = source.indexOf('const serverEntries = () => {')
  const to = source.indexOf('return entries', from)
  return from === -1 || to === -1 ? '' : source.slice(from, to)
})()
check('FR-018: список серверов берётся из реестра шлюза, а не из конфига плагина',
  serverEntriesBody.includes('for (const serverName of state.registry.keys())')
  && !serverEntriesBody.includes('catalog.servers')
  && source.includes('Конфиг плагина может сузить набор и подписать сервер, но не добавить'))
check('FR-018: серверы из конфига без гранта перечисляются сноской, а не строками',
  source.includes('const configOnlyServers = () =>')
  && source.includes('configOnlyServers: configOnlyServers()')
  && client.includes('configOnly') && client.includes('в конфиге, но не выданы ключу: '))
check('FR-018a: требования сервера приходят из шлюза, а не из конфига',
  source.includes("gatewayGet('/v1/mcp/user-env-vars/status', key)")
  && source.includes('authType: registryEntry ? registryEntry.authType :')
  && client.includes('function requirementChips(server)')
  && client.includes('dshMcpChipCode') && client.includes('title: chip.hint'))
check('FR-018a: адрес приёма переменной шлюза остаётся в состоянии (диагностика)',
  source.includes('setupUrl: absoluteSetupUrl(entry.setup_url)')
  && source.includes('setupUrl: mount && mount.setupUrl ? mount.setupUrl : (env ? env.setupUrl : \'\')'))
check('FR-018: у плагина больше нет своих полей под личные ключи серверов',
  !client.includes('Личный ключ') && !client.includes('SecretDialog')
  && !client.includes('tokenRef'))
check('FR-019: заголовки, которые требует сервис, вводятся в экране и уходят при монтировании',
  source.includes('function serverHeadersRef(')
  && source.includes('function headerNamesFromDescription(')
  && source.includes('const requiredHeaderNames = (server, record) =>')
  && source.includes('const readServerHeaders = async (serverName) =>')
  && source.includes('buildHeaders(server, litellmKey, personalToken, extraHeaders)')
  && source.includes("register(pagePath + '/api/server-header', 'POST', handleServerHeader)")
  && source.includes("markSkipped(server, 'no-header',")
  && client.includes('function ServerHeaders(props)')
  && client.includes('headerRequired') && client.includes("'Свой заголовок'"))
check('FR-019: имя заголовка берётся из описания сервера в шлюзе, а не из конфига',
  source.includes('extraHeaders: Array.isArray(entry.extra_headers)')
  && source.includes('headerNamesFromDescription(record.description)')
  && !source.includes('X-Redmine-User-Key\', \'config\'')
  && client.includes("headerListOf(server).forEach((item) => chips.push({ name: item.name"))
check('FR-020: личное значение переменной пишется в шлюз ключом пользователя',
  source.includes('const gatewaySend = async (method, path, key, body) =>')
  && source.includes('gatewaySend(\'POST\', \'/v1/mcp/server/\' + target.serverId + \'/user-env-vars\',')
  && source.includes('{ values: { [name]: value } }')
  && source.includes("register(pagePath + '/api/env-var', 'POST', handleEnvVar)")
  && source.includes('const token = activeGrant()'))
check('FR-020: снятие личных значений идёт DELETE на шлюзе',
  source.includes('gatewaySend(\'DELETE\', \'/v1/mcp/server/\' + target.serverId + \'/user-env-vars\',')
  && source.includes("register(pagePath + '/api/env-var-clear', 'POST', handleEnvVarClear)"))
check('FR-020: шлюз получает только объявленные им имена, значение в журнал не попадает',
  source.includes('declared.indexOf(name) === -1')
  && source.includes("journal('env var ' + server.name + ' set ' + name + ' length=' + value.length)")
  && !source.includes("' set ' + name + ' value='"))
check('FR-020: значение вводится в экране серверов, а не в админке LiteLLM',
  client.includes('function ServerEnvVars(props)')
  && client.includes('onSaveEnvVar') && client.includes('onClearEnvVars')
  && client.includes("'Снять'")
  && !client.includes('Заполнить в шлюзе'))
check('FR-017d: строка сервера короткая — статус, счётчик и имена требований',
  client.includes('function requirementChips(server)')
  && client.includes("h('div', { className: 'dshMcpSrvLine' }")
  && !client.includes('инструменты ещё не получены')
  && !client.includes('требует: ')
  && !client.includes('Нужны переменные окружения'))
check('FR-019b: живость личного значения проверяется в любом режиме — проба *whoami*',
  source.includes('const verifyToolOf = (server) =>')
  && source.includes('registeredTools(server.serverName).find((name) => /whoami/i.test(name))')
  && source.includes('const probeTarget = Object.assign({}, server, { verifyTool: probeTool })')
  && !source.includes('проверка живости не выполняется'))
check('FR-020e: вердикт проверки принадлежит значению и токену, а не серверу',
  source.includes('const verifyEpochOf = (serverName)')
  && source.includes('verifyEpochOf(server.name) !== epoch')
  && source.includes("' discarded: значение изменилось во время проверки'")
  && source.includes('const invalidateVerify = (serverName) =>')
  && source.includes('const clearRejection = (serverName) =>')
  && (source.match(/clearRejection\(server\.name\)/g) || []).length >= 3
  && source.includes('state.verify.clear()')
  && source.includes('state.tokenRejected.clear()'))
check('FR-020f: монтирование повторяется, статус пересчитывается по факту тулзов',
  source.includes('mountRetryAttempts: z.number().step(1).default(3)')
  && source.includes('const failMount = (reason) =>')
  && source.includes('const stallTimer = setTimeout')
  && source.includes('const recalcMounts = () =>')
  && source.includes('recalcMounts()'))
check('FR-017e: без активного токена список серверов не исчезает',
  source.includes('const knownEntries = serverEntries()')
  && source.includes('const knownNames = knownEntries.length > 0')
  && source.includes("const affected = only === undefined ? knownNames : knownNames.filter((serverName) => only.has(serverName))")
  && source.includes("for (const serverName of affected) skipKnown(serverName, skipStatus, state.registryError)")
  && source.includes('serverNames: [...state.lastServerNames]')
  && source.includes('if (Array.isArray(persisted.serverNames)) state.lastServerNames = [...persisted.serverNames]'))
check('NFR-003: чужая ошибка попадает в журнал без похожего на секрет текста',
  source.includes('const sanitizeUpstream = (text) =>')
  && source.includes('sanitizeUpstream(message).slice(0, 160)')
  && source.includes('appendFile(logFile, text, { mode: 0o600 })')
  && source.includes('chmod(logFile, 0o600)'))
check('FR-020d: запись личного значения перемонтирует только свой сервер',
  source.includes('const applyServers = (reason, names) => {')
  && source.includes('prepared = await prepareMounts(reason, targeted)')
  && source.includes('if (only !== undefined && !only.has(serverName)) continue')
  && source.includes("await applyServers('env-var', [server.name])")
  && source.includes("await applyServers('server-header', [server.name])")
  && !source.includes("await applyActiveToken('env-var')"))
check('FR-020c: новая запись значения не наследует прошлый отказ, verify работает для шлюзовых серверов',
  source.includes('// Значение заменено — прежний вердикт и запрет тулзов относились к другому значению.')
  && source.includes("'verify ' + name + ' deferred: сервер ещё не смонтирован")
  && source.includes('const server = resolveServer(requestedName)'))
check('FR-020: запись значения сразу проверяется, снятие — сбрасывает вердикт',
  source.includes('await verifyNow(server.name)')
  && source.includes('invalidateVerify(server.name)'))
check('FR-017d: сервер — отдельный блок со своей точкой статуса и кнопкой проверки',
  client.includes("'dshMcpSrvBlock dshMcpSrvBlock--' + state.tone")
  && client.includes("className: 'dshMcpDot dshMcpDot--' + state.tone")
  && client.includes("'Проверить'")
  && client.includes("store.run('verify:' + server, '/verify'"))
check('FR-020: экран знает id записи шлюза, по которому пишется значение',
  source.includes('const envVarTarget = async (serverName) =>')
  && source.includes('serverId: (env !== undefined && env.serverId !== \'\' ? env.serverId : \'\')')
  && source.includes('envRequired: env ? env.required : []'))

check('деньги: /api/state не ждёт шлюз — только кеш бюджета',
  source.includes('budget: budgetPeek(state.activeToken)')
  && !source.includes('await describeBudget(activeTokenRecord)'))
check('деньги: сбор бюджета один на всех (single-flight), с дедлайном и без кеша ошибок',
  source.includes('budgetPending')
  && source.includes('Promise.race([collectBudget(token), deadline])')
  && source.includes('budgetTimeoutMs')
  && source.includes("if (data.error === '') {"))
check('деньги: смена ключа сбрасывает кеш прошлого аккаунта', source.includes('invalidateBudget()'))
check('деньги: карточка и чип тянут /api/budget сами, состояние даёт только кеш',
  client.includes('function useBudgetFeed')
  && client.includes('useBudgetFeed({ initial: props.initial, live: true })')
  && client.includes('useBudgetFeed({ live: true })')
  && client.includes('h(BudgetCard, { initial: data.budget })'))

check('гейт: deny собирается только из текущего реестра, без «когда-либо виденных» имён',
  source.includes('const names = []')
  && source.includes('if (!isManagedTool(toolName)) continue')
  && !source.includes('const names = new Set(state.knownManagedTools)'))
check('гейт: размонтирование забывает имена тулзов сервера',
  source.includes('const forgetManagedTools = (serverName) =>')
  && source.includes('forgetManagedTools(mount.serverName)'))
check('гейт: отказ restrict поднимает деградацию, а не тонет в журнале',
  source.includes('state.gateErrors.set(record.label, message)')
  && source.includes('gateErrors: [...state.gateErrors.entries()]')
  && source.includes("if (state.gateErrors.size > 0) return 'гейт не применился: '"))
check('монтирование изолировано по серверам: Config/ctx.plugin под try',
  source.includes('fiber = ctx.plugin(McpClient, validated)')
  && source.includes("markSkipped(server, 'failed', reason)"))
check('фаза по фактам: точечное применение не стирает деградацию чужого сервера',
  source.includes('state.lastError = currentFailure(failure)')
  && source.includes('const currentFailure = (prepareFailure) =>'))
check('повтор не снимает тулзы: «нечего применять» без ретраев, упавшие — точечно',
  source.includes('const applyIsIdle = () =>')
  && source.includes("retryLight('auto-retry#' + retryState.attempts)")
  && source.includes("journal('retry ' + reason + ': только упавшие серверы ('"))
check('старт: stateFile решает «подключено/отключено», конфиг — фолбэк первого запуска',
  source.includes('if (!persisted.exists) {')
  && source.includes('// Пустая строка в файле — это «Отключить»; конфиг её не отменяет.')
  && !source.includes("if (cfg.activeToken !== '' && catalog.tokens.has(cfg.activeToken)) state.activeToken = cfg.activeToken"))
check('старт: токен экрана с тем же id, что в конфиге, не теряет сужение models[]',
  source.includes('const merged = Object.assign({}, token, {')
  && source.includes('права взяты из конфига'))
check('снимки: ref провайдера и личные значения снимаются перед записью/снятием',
  source.includes("await snapshotCredential(providerRef, '')")
  && source.includes('await snapshotCredential(token.keyRef, value)')
  && source.includes('await snapshotCredential(ref, JSON.stringify(headers))'))

const manifest = JSON.parse(await readFile(new URL('package.json', here), 'utf8'))
check('совместимость объявлена: engines.dsh и peer на @deepseek-ai/dsh — одной линией',
  manifest.engines !== undefined && manifest.engines.dsh === '^0.2.1-rc.2 || ^0.2.2-alpha.2'
  && manifest.peerDependencies !== undefined && manifest.peerDependencies['@deepseek-ai/dsh'] === manifest.engines.dsh
  && manifest.peerDependenciesMeta !== undefined && manifest.peerDependenciesMeta['@deepseek-ai/dsh'].optional === true)
check('механика версии: чтение версии DSH, сверка диапазона, гейт гост-пакетов',
  source.includes('const dshRuntime = detectDshRuntime()')
  && source.includes('const dshCompat = checkDshCompat(dshRuntime.version, DSH_TESTED_RANGE)')
  && source.includes('async function hostImport(spec)')
  && source.includes("'плагин не проверялся на DSH '"))
check('совместимость видна снаружи: /api/state.dsh и configErrors про отсутствующие возможности',
  source.includes('dsh: dshCompat,')
  && source.includes('const missingCapabilities = requiredCapabilities')
  && source.includes("'в этой сборке DSH нет: '"))
check('диапазон проверки в коде совпадает с объявленным engines.dsh (одна правда, не две)',
  source.includes("const DSH_TESTED_RANGE = '" + manifest.engines.dsh + "'")
  && source.includes('checkDshCompat(dshRuntime.version, DSH_TESTED_RANGE)'))
check('матрица прогонов: 4 версии DSH объявлены проверенными, глубина — в заметке',
  source.includes("const DSH_TESTED_VERSIONS = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2']")
  && source.includes('const DSH_TESTED_NOTE = ')
  && source.includes('DSH_TESTED_VERSIONS.includes(dshCompat.version)'))
check('релиз одной командой: scripts/release.mjs есть и знает про зеркало и тег',
  manifest.scripts.release === 'node scripts/release.mjs'
  && (await readFile(new URL('scripts/release.mjs', here), 'utf8')).includes("const tag = 'v' + next"))

check('деньги: сутки считаются в UTC, как агрегирует шлюз (иначе «сегодня» пусто с 00:00 до 03:00 MSK)',
  source.includes('date.getUTCFullYear()')
  && source.includes("dayBasis: 'utc',")
  && !source.includes('date.getFullYear() + \'-\''))
check('деньги: карточка показывает, на какое время данные, и не замирает открытой',
  client.includes("' Данные на ' + new Date(budget.fetchedAt).toLocaleTimeString('ru-RU')")
  && client.includes('Сутки — в UTC, как их считает шлюз LiteLLM'))
check('каталог сужается только для своего маршрута: чужие провайдеры не трогаются',
  source.includes('if (!modelState.known || providerId !== modelState.provider) return models')
  && source.includes('const installModelGate = () =>')
  && source.includes('llm.registerAdapter([providerId], route.adapter)'))
check('проверка обновлений: маршрут /api/update, кеш и сравнение с тегами публикации',
  source.includes("register(pagePath + '/api/update', 'GET'")
  && source.includes('const collectUpdate = async () =>')
  && source.includes('const describeUpdate = async (force = false) =>')
  && source.includes('const updatePeek = () =>')
  && source.includes("'dsh plugin --profile <профиль> add github:'"))
check('проверка обновлений: конфиг (вкл/репо/кеш/таймаут) и блоки в /api/state и /api/diag',
  source.includes('updateCheck: z.boolean().default(true)')
  && source.includes('updateRepo: z.string().default(')
  && source.includes('updateCheckMs: z.number().min(0).default(86400000)')
  && source.includes('updateTimeoutMs: z.number().default(5000)')
  && source.includes('update: updatePeek(),')
  && source.includes('plugin: { version: SELF_VERSION, testedDsh: DSH_TESTED_VERSIONS, testedNote: DSH_TESTED_NOTE }'))
check('проверка обновлений в UI: чип рядом с бюджетом и карточка в настройках',
  client.includes('function UpdateChip()')
  && client.includes('function UpdateCard()')
  && client.includes("id: 'verme-gate-update'")
  && client.includes('h(UpdateCard, null)')
  && client.includes('function useUpdateFeed(options)'))

console.log('')
console.log(failures === 0 ? 'selftest: PASS' : 'selftest: FAIL (' + failures + ')')
process.exitCode = failures === 0 ? 0 : 1
