# Краевые случаи llm-маршрута `dshlab` (verme-gate)

Живой чек-лист для динамического маршрута: плагин сам объявляет llm-провайдера `dshlab`
(`createProvider` + `getModels()` из прав активного ключа + `PiAiAdapter` + `llm.registerAdapter`,
см. `plugins/dsh-mcp-access/lib/gateway-route.js`).

Две опоры: **контракт** (что обязано быть по исходникам DSH/pi-ai) и **проверка** (команда → ожидаемый
результат). Ссылки на исходники даны от корня `/home/seva/dsh-prod021-pkg/node_modules`; обёртка
`@deepseek-ai/dsh-llm-pi-ai` сокращена как `dsh-llm-pi-ai`, `@deepseek-ai/dsh-llm` — `dsh-llm`.
Ссылки на плагин — от `plugins/dsh-mcp-access/` (`lib/gateway-route.js`, `index.js`).

Версия, на которой снят факт: плагин **0.3.2** (маршрут владеет сам, каталог с ёмкостями,
`maxTokens` применяется, `off → low`), DSH 0.2.1-rc.2, стенд :3091, 2026-10-27 15:00–15:27 MSK.
Факты 0.3.1, которые 0.3.2 изменила, помечены в тексте как «в 0.3.1 было …».

## Стенды и доступы

| Стенд | Что это | Как гонять |
|---|---|---|
| Живой (главный) | лаб-инстанс `http://127.0.0.1:3091`, `DSH_HOME=/home/seva/.dsh-lab-3091`, unit `dsh-lab-3091`, журнал плагина `/home/seva/.dsh-lab-3091/storages/verme-gate.log` | `systemctl --user restart dsh-lab-3091` (стенд наш, рестарт свободный) |
| Контрактный | `/tmp/edge-cases.mjs` + фейковый шлюз `/tmp/edge-fake2.mjs` на `127.0.0.1:3110`: реальные pi-ai 1.3.0 + dsh-llm-pi-ai + dsh-llm, вызывает `buildGatewayRoute()` как есть | `EDGE_PORT=3110 node /tmp/edge-fake2.mjs &` затем `HTTPS_PROXY=http://127.0.0.1:3128 NO_PROXY=...,.ru node /tmp/edge-cases.mjs` |
| Перехват тела запроса | `/tmp/edge-forward-proxy.mjs` (127.0.0.1:3111 → живой шлюз), пишет ключи тела в `/tmp/edge-forward-body.log` | `node /tmp/edge-forward-proxy.mjs &`, затем прогон маршрута с `baseUrl: http://127.0.0.1:3111/v1` |

Токен входа и cookie лабы (токен меняется на каждом старте):

```bash
TOKEN=$(journalctl --user -u dsh-lab-3091 --no-pager | grep -o "token=[A-Za-z0-9_-]*" | tail -1 | cut -d= -f2)
curl -sS -c /tmp/c3091.txt "http://127.0.0.1:3091/?token=$TOKEN" -o /dev/null
bash /tmp/edge-state-summary.sh   # сжатая сводка /api/state: токен, модели, ошибки, liveCatalog
```

Признак поднятого маршрута: в журнале `models: own route "dshlab" registered, api=openai-completions
(каталог живой: getModels)` (`index.js:2162`) и в селекторе GUI — полный каталог прав ключа. Счётчика
моделей в строке нет намеренно (в 0.3.1 он печатал `catalog=0` до discovery и вводил в заблуждение).

## Сводка: что подтверждено на живой лабе

| Что | Факт (2026-10-27, :3091) |
|---|---|
| каталог = права ключа | 62 модели в селекторе GUI = 62 в `GET /v1/models` (шлюз отдаёт 62 id) |
| ёмкости из шлюза | `deepseek-flash`/v4-pro/v4-flash → **1M**, `claude-opus-5.5` → **200K**, `gpt-5.6-luna` → **922K**, остальные → **131K** (диалог «% контекста») |
| автокомпакт v4-pro | окно 1 000 000 вместо 131 072 — прежние ~104k сняты |
| reasoning_effort | в теле запроса `reasoning_effort:"low"` уходит; шлюз принимает у 12+ моделей, ни одного 400 |
| смена токена при открытой сессии | каталог сменился 46 → 62 без рестарта и без перезагрузки страницы |
| мусорный ключ | `GET /models -> HTTP 401`, каталог удержан прежним, ход падает `AUTH` «API key is invalid» |
| отмена стрима | «Stop generating» → статус Stopped, частичный текст сохранён, ошибки нет |
| двойной рестарт | ровно одна строка регистрации на старт, `DUPLICATE_ADAPTER` нет |
| конфликт `dshlab` в патче | журнал `already registered` + подсказка; плагин жив; селектор = статический список (1 модель) |
| повторный идентичный вызов | два прогона подряд: ответ тот же, ошибок нет (форма reasoning-потока не детерминирована) |
| выходной лимит из шлюза (0.3.2) | `prepareCall`: v4-pro `defaultMaxTokens=393216`, opus `64000`, luna `128000`; без полей шлюза — поля нет |
| `reasoningEffort:'off'` (0.3.2) | не падает: 4 модели ответили `stop` (на провод уходит `reasoning_effort:"low"`, т.е. «off» ≠ выключено) |
| выбор вне прав нового ключа | селектор = 1 модель, сессия сама переехала на `deepseek/deepseek-flash` (журнал `reselect`), отправка ок |
| диагностика (0.3.2) | `/api/state.models`: `route {provider,installed,api,models:62}` + `limits` (6 записей) |

---

## 1. Повторный идентичный вызов

**Контракт.** Один шаг = один `prepareCall` + один `stream` (`dsh-agent-loop/lib/index.js:1051-1091`),
подготовленный вызов одноразовый: второй `stream()` бросает `INVALID_PREPARED_CALL`
(`dsh-llm/lib/index.js:2249-2251`). Повтор шага бывает только по ретраю: `dsh-llm-retry` вызывает
`agent/request-error` и просит `{kind:"retry"}` (`dsh-llm-retry/lib/index.js:151-173`), агент-луп
переисполняет шаг целиком, т.е. отправляет НОВЫЙ идентичный HTTP-запрос
(`dsh-agent-loop/lib/index.js:1136-1146`). Внутренние ретраи pi-ai отключены: `maxRetries: 0`
(`dsh-llm-pi-ai/lib/index.js:1764`), поэтому двойного ретрая «адаптер × ядро» нет.

**Ожидаемо.** Никакой дедупликации: два одинаковых сообщения = два POST, оба оплачиваются.
Повтор после ошибки идёт с бэкоффом 500 мс → ×2, лимит 5 попыток
(`dsh-llm/lib/types/retry-policy.js:12-22,84-91`). Не ретраятся `AUTH`, `MISSING_CREDENTIAL`,
`INVALID_REQUEST`, `UNKNOWN_MODEL`, `ABORTED`, `PI_AI_ERROR`.

**Как проверить.** Контрактный стенд: `/tmp/edge-cases.mjs` дважды подряд гонит
`deepseek/deepseek-flash`; в GUI :3091 — два одинаковых сообщения в одной сессии.

**Факт.**
* Стенд: оба прогона `finish {kind:"stop"}`, текст «ок» одинаковый; форма потока разная
  (первый: 2 блока + 15 `reasoning-delta`, второй: 1 блок без reasoning) — модель не обязана
  отдавать размышления, поэтому сверять надо текст и финиш, а не гистограмму чанков.
* GUI: два сообщения подряд в одной сессии → два ответа, ошибок нет.
* `retryPolicy` маршрута (`buildGatewayRoute`, `lib/gateway-route.js:76`):
  `{"mode":"normal","maxRetries":5,"retryableCodes":["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],"initialDelayMs":500,"maxDelayMs":10000,"jitterRatio":0.1}`.

**Статус.** Проверено фактом (стенд + GUI).

## 2. Отмена стрима посреди ответа

**Контракт.** Агент-луп передаёт `signal` шага в `stream` (`dsh-agent-loop/lib/index.js:1078,1084-1092`),
при отмене сохраняет уже полученные блоки как `assistant/message` с `interrupted: true`
(`:1096-1112`). `PiAiAdapter` комбинирует сигнал вызывающего со своим
(`dsh-llm-pi-ai/lib/index.js:1955-1956`), на выходе глушит потребителя и делает `iterator.return()`
(`:2001-2007,2012-2014`), терминальный статус — `finish {kind:"aborted", code:"ABORTED"}`
(`:1506-1512`). `ABORTED` не ретраится.

**Как проверить.** GUI :3091: длинный промпт («напиши 3000 слов…»), через 2 с — кнопка
«Stop generating». Плюс стенд: отмена по сигналу через 2 дельта-чанка и «зависший» шлюз.

**Факт.**
* GUI: статус `Stopped`, частичный текст («…разгромили русские дружины на реке Сити») остался в
  чате, тоста ошибки нет, композер снова активен, следующий запрос проходит.
* Стенд: `edge-slow` + abort после 2 дельт → `aborted/ABORTED`, частичный текст `tok0 tok1`;
  `edge-hang` (шлюз молчит) + abort через 2 с → `aborted/ABORTED` (зависания нет, watchdog жив).

**Статус.** Проверено фактом (GUI + стенд).

## 3. Таймаут / обрыв сети до шлюза

**Контракт.** Два независимых предела:
* idle-watchdog стрима — `profile.streamIdleTimeoutMs = 300000` (`lib/gateway-route.js:131`;
  дефолт `dsh-llm-pi-ai/lib/index.js:1127`) → `LlmError TIMEOUT` (`:2009`) → код `TIMEOUT`
  входит в retryable-набор;
* ошибки соединения pi-ai отдаёт текстом «Connection error.» → классификация в `TRANSPORT`
  (`dsh-llm-pi-ai/lib/index.js:1456-1457`) → тоже ретраится.
Ретраи выполняет `dsh-llm-retry` (не адаптер): 500 мс ×2, максимум 5 попыток
(`dsh-llm/lib/types/retry-policy.js:12-22`); `Retry-After` шлюза адаптер не пробрасывает —
в `dsh-llm-pi-ai` нет ни одного упоминания `retryAfter`.

**Как проверить.** Стенд: модель `edge-drop` фейкового шлюза отдаёт 200 + один дельта-чанк и рвёт
сокет. Живой вариант — направить `llmBaseUrl` на закрытый порт (нужен рестарт юнита) либо
остановить шлюз на время запроса.

**Факт.** `edge-drop` → частичный текст «первый» + `finish {kind:"error", code:"TRANSPORT"}`.
300-секундный idle-watchdog вживую не досиживали (предел слишком велик для теста); закрытый порт
проверен ранее на контрактном стенде (`TRANSPORT`, «Connection error.»).

**Статус.** Проверено фактом: обрыв связи (TRANSPORT). НЕ проверено: 300-секундный idle-таймаут
вживую и число повторов ретрая в журнале агента.

## 4. HTTP 401 / 403 / 429 (и 5xx) от шлюза

**Контракт.** pi-ai превращает ошибку провайдера в текст `"401: {…}"`
(`@earendil-works/pi-ai/dist/api/openai-completions.js:505`, `utils/error-body.js:111-118`),
обёртка классифицирует по тексту (`dsh-llm-pi-ai/lib/index.js:1448-1459`): 401/403 → `AUTH`,
429 → `RATE_LIMIT`, 5xx → `SERVER`, 400/413 → `INVALID_REQUEST`, quota-формулировки → `QUOTA`.
Ретраятся `RATE_LIMIT`/`SERVER`, не ретраятся `AUTH`/`INVALID_REQUEST`. 403 на модель = «у ключа нет
прав на эту модель»; авто-подмены модели нет.

**Как проверить.** 401 — мусорный ключ (§6), виден в GUI. 403/429/5xx — фейковый шлюз
(`edge-403`, `edge-429`, `edge-500`): на живом шлюзе таких ответов не вызвать.

**Факт.**
* Живой 401 (мусорный ключ активного токена): ход `Failed`, в чате «This turn failed /
  API key is invalid», код `AUTH`; ни одного повтора (AUTH не ретраится).
* Стенд: `edge-401` → AUTH, `edge-403` → AUTH, `edge-429` → RATE_LIMIT, `edge-500` → SERVER,
  `edge-empty` (finish без контента) → EMPTY_RESPONSE.

**Статус.** Проверено фактом: 401 (живой), 403/429/5xx/empty (стенд). НЕ проверено: живые 403 и 429
(живой шлюз их не отдаёт по нашей модели) и фактическое число ретраев 429/5xx в журнале агента.

## 5. Смена активного токена во время сессии

**Контракт.** `PiAiAdapter` читает профили на КАЖДУЮ операцию (`current()`,
`dsh-llm-pi-ai/lib/index.js:1852-1862`), профиль плагина пересобирается на каждый вызов
(`lib/gateway-route.js:120-143`), `getModels()` смотрит в текущий каталог
(`:80,112`), ключ спрашивается на каждый вызов (`resolveApiKey`, `:1954` и `:1892`).
Смена токена видна следующему запросу без рестарта и без рекомпозиции конфига. Плагин дополнительно
переставляет живых агентов и дефолтную модель, если выбор вне новых прав (`index.js:2212`
`reselectLiveAgents`, `:2235` `ensureDefaultModel`). Гонка: если сессия выбрала модель, которой у
нового ключа нет, `prepareCall` бросит `UNKNOWN_MODEL` (`dsh-llm-pi-ai/lib/index.js:1875`).

**Как проверить.** Открыть GUI, выбрать не дефолтную модель, затем
`POST /verme-gate/api/active {"tokenId":"<другой>"}`, не перезагружая страницу — открыть селектор.

**Факт.** После переключения на мусорный токен и обратно каталог в GUI обновился с 46 до 62 моделей
без перезагрузки страницы и без рестарта юнита (`/api/active` отвечает 200, `apply#N token=… ` в
журнале). Заодно выяснилось, что сам шлюз за это время вырос 46 → 62 id (`GET /v1/models` = 62,
6886 байт) — маршрут это подхватил на следующем же apply.

**Факт: выбор, которого у нового ключа нет (0.3.2, живой стенд).** Права второго ключа сымитировали
операторским сужением того же ключа: в лаб-патче
`verme-gate.config.tokens: [{id: edge-subset, keyRef: <тот же>, models: [deepseek/deepseek-flash]}]`.
До переключения сессия стояла на `anthropic/claude-opus-5.5`.

* `POST /api/active {tokenId:"edge-subset"}` → `allowed=1`, журнал
  `apply#2 token=edge-subset … models=1 (token-switch:edge-subset)`.
* Залипания на мёртвом id НЕТ: ещё до отправки в журнале
  `default model persisted -> dshlab/deepseek/deepseek-flash` и
  `reselect agent=session-c8878e68-… #1 -> dshlab/deepseek/deepseek-flash` (`ensureDefaultModel` +
  `reselectLiveAgents`); кнопка модели в ОТКРЫТОЙ странице сменилась на `deepseek/deepseek-flash`
  без перезагрузки, селектор показал ровно 1 пункт, отправка прошла (`stop`).
* Холодный старт с тем же сужением (restart + reload) → мёртвого id нигде нет, сообщение проходит.
* Обратное переключение (62 модели) НЕ возвращает прежний `claude-opus-5.5`: остаётся
  `deepseek/deepseek-flash` — «переезд» односторонний, прежний выбор не восстанавливается.
* `UNKNOWN_MODEL` в этом сценарии не воспроизводится: плагин чинит выбор раньше, чем агент дойдёт до
  `prepareCall`. Ошибка остаётся теоретической (агент, поднятый до подмены каталога).
* Побочный факт: сузить права токена можно только конфигом оператора — токены с экрана всегда
  получают `models: []` (`normalizeUiToken`), и `models` не пишется в stateFile (`stateDoc`,
  index.js:2868-2884).

**Статус.** Проверено фактом: каталог меняется без рестарта; выбор вне прав нового ключа
переставляется автоматически (журнал + GUI), `UNKNOWN_MODEL` не возникает.

## 6. Пустой каталог (ключ без моделей) и невалидный ключ

**Контракт.** `listModels` отдаёт `[]`, если ключа нет (`MISSING_CREDENTIAL` глушится,
`dsh-llm-pi-ai/lib/index.js:1891-1896`), `buildModelCatalog` выбрасывает пустые группы
(`dsh-api-session-controller/lib/index.js:593-609`). Плагин при неудачном `GET /v1/models`
НЕ обнуляет каталог: держит прежний и пишет `ERROR discovery: GET /models -> HTTP N (каталог держим:
M моделей)`; `modelState.error` несёт текст ошибки, `keyState: "error"`.

**Как проверить (не ломая рабочий токен).**
```bash
bash /tmp/edge-lab-api.sh POST /api/token-add '{"label":"edge-bogus","id":"edge-bogus"}'
bash /tmp/edge-lab-api.sh POST /api/token-key '{"token":"edge-bogus","value":"sk-bogus-edge-0000"}'
bash /tmp/edge-lab-api.sh POST /api/active  '{"tokenId":"edge-bogus"}'
bash /tmp/edge-state-summary.sh          # models.error, keyState, allowed
# ... отправить сообщение в GUI ...
bash /tmp/edge-lab-api.sh POST /api/active '{"tokenId":"klyuch-iidq"}'   # вернуть
bash /tmp/edge-lab-api.sh POST /api/token-remove '{"token":"edge-bogus"}'
```

**Факт.**
* `models.error: "GET /models -> HTTP 401"`, `keyState: "error"`, `phase: "degraded"`,
  `lastError: "GET /v1/mcp/server -> HTTP 401"`.
* Каталог в селекторе НЕ опустел: остались те же 46 моделей (журнал:
  `ERROR discovery: GET /models -> HTTP 401 (каталог держим: 46 моделей)`). То есть «пустого
  каталога» в этом сценарии не бывает — удерживается последний удачный.
* Отправка сообщения: `Failed` / «API key is invalid» / `AUTH` (один ход, без ретраев).
* Плагин сам ретраит apply: `auto-retry#1..#3` с паузами ~1.3 с, 2.8 с, 10 с.
* Возврат токена: `phase: "ready"`, каталог 62, ошибки сняты, рестарт не нужен.

**Статус.** Проверено фактом. Расхождение с ожиданием: каталог не пустеет, а «залипает» на прежнем
наборе (см. §13 — это осознанно, но в UI выглядит как рабочий список).

## 7. Отсутствующий ключ

**Контракт.** `resolveApiKey` плагина бросает `LlmError MISSING_CREDENTIAL`
(`lib/gateway-route.js:154-160`), это не ретраится (`dsh-llm/lib/types/retry-policy.js:16-22`);
`listModels` при этом отдаёт `[]` (`dsh-llm-pi-ai/lib/index.js:1891-1896`), а не падает.
Текст: «verme-gate: у активного токена нет ключа LiteLLM».

**Факт (стенд).** `stream` → `LlmError MISSING_CREDENTIAL: verme-gate: у активного токена нет ключа
LiteLLM`; `listModels` → `[]`. Живьём не воспроизводили: снимать ключ у активного токена =
ломать рабочий стенд, а на мусорном токене ключ есть (он просто неверный, это §6).

**Статус.** Проверено фактом на стенде. Живой сценарий — нет (осознанно).

## 8. Конфликт: `dshlab` объявлен ещё и в патче профиля

**Контракт.** Регистрация маршрута all-or-nothing: повторный владелец даёт `DUPLICATE_ADAPTER`
(`dsh-llm/lib/index.js:1842-1872`). Порядок загрузки решает, кто упадёт: llm-pi-ai раньше (штатный
порядок: бандл-слой раньше insert-слоя плагина) → падает `registerAdapter` плагина, плагин ловит и
журналирует (`index.js:2162-2167`); плагин раньше → падает регистрация llm-pi-ai
(`dsh-llm-pi-ai/lib/index.js:2943-2965`). Плагины-образцы проверяют это заранее
(`dsh-codex-connect/lib/index.js:12342,5911-5913`) или ловят исключение
(`dsh-grok-subscription/lib/index.js:2670-2678`).

**Как проверить.**
1. В `~/.dsh-lab-3091/profiles/web/cordis.patch.yml` добавить
   `- id: llm-pi-ai` + `config.providers.dshlab` (api `openai-completions`, `baseURL` шлюза,
   `apiKeyEnv: MCP_ACCESS_LLM_KEY`, один id в `models`), рестарт.
2. Смотреть журнал плагина и селектор GUI; отправить сообщение.
3. Убрать запись (бэкап: `cp /tmp/edge-patch-backup.yml …`), рестарт — маршрут снова поднят.

**Факт.**
* Журнал: `ERROR llm route "dshlab": an adapter for provider "dshlab" is already registered
  (если провайдер объявлен в cordis.patch.yml — убери его оттуда: маршрутом владеет плагин)`.
* Плагин не падает: `/api/state` → `phase: "ready"`, каталог прав 62, MCP-монтирования живы.
* В GUI кнопка модели — «Select model» без текущей модели (дефолт `openai/gpt-5.6-luna` в статическом
  списке отсутствует), в селекторе РОВНО один пункт — `deepseek/deepseek-flash` из статического патча.
* Отправка через статический провайдер работает (ответ пришёл), но контекст там 262K — статический
  дефолт llm-pi-ai, а не 131072 объявленный маршрутом.
* После отката патча и рестарта: `own route "dshlab" registered`, селектор снова 62, стрим идёт.

**Статус.** Проверено фактом (ветка «llm-pi-ai раньше»). Ветка «плагин раньше» на практике
недостижима без правки порядка загрузки — не проверена.

## 9. Рестарт / перезагрузка плагина (dispose → повторная регистрация)

**Контракт.** `registerAdapter` возвращает disposer, живущий на фибере плагина: `ctx.effect(...)`
удаляет маршруты при dispose и публикует `llm/adapters-updated` (`dsh-llm/lib/index.js:1842-1861`).
Плагин дополнительно снимает регистрацию своим эффектом (`index.js:2150-2159`); `replace()` после
dispose запрещён (`REGISTRATION_DISPOSED`, `dsh-llm/lib/index.js:1856-1858`) — плагин им не пользуется.

**Как проверить.** `bash /tmp/edge-restart.sh` дважды подряд; между ними отправить сообщение в GUI.

**Факт.** Два рестарта: на каждый старт РОВНО одна строка `models: own route "dshlab" registered`
(журнал, строки 123/141/177 — по одной на старт), `DUPLICATE_ADAPTER` и
`already registered` нет (единственная такая строка — из теста конфликта §8). После каждого
рестарта каталог 62 и стрим в GUI проходит.

**Статус.** Проверено фактом.

## 10. E2E: выбор не-дефолтной модели и стрим (главный критерий)

**Факт (GUI :3091, MCP chrome-devtools).** Селектор → 62 id (группа провайдера `dshlab`).
Прошли стримом и ответили: `deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`,
`anthropic/claude-opus-5.5`, `openai/gpt-5.6-luna`, `z-ai/glm-5.3-flash` (и десяток других на
стенде: `tencent/hy3`, `google/gemini-4-argon`, `gemini-vl`, `GeneralPurpose`, `CodeReview`,
`deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-flash-0731`, `openrouter/gpt-5.6-luna`).
В `/api/state` → `models.current` = `{provider:"dshlab", model:<id>}`.
В теле запроса (перехват прокси 3111): `model`, `messages`, `stream`, `stream_options:{include_usage:true}`,
`reasoning_effort:"low"`, `max_completion_tokens`, `store`; `prompt_cache_key` НЕ уходит.

**Статус.** Проверено фактом.

## 11. Ёмкости моделей (бывшая главная боль)

**Контракт.** Ёмкость объявляется моделью pi-ai: `contextWindow` берётся из каталога шлюза
(`max_input_tokens`), иначе дефолт (`lib/gateway-route.js:25,51`); агент читает её через
`modelInfo` (`dsh-llm/lib/index.js:2129-2138`) и по ней считает порог автокомпакта.

**Факт (живой :3091).** Диалог «% контекста»:

| Модель | Шлюз `max_input_tokens` | Окно в GUI |
|---|---|---|
| `deepseek/deepseek-flash` | 1 000 000 | `~11K / 1M` |
| `deepseek/deepseek-v4-pro` | 1 000 000 | `~10.7K / 1M` |
| `deepseek/deepseek-v4-flash` | 1 000 000 | 1 000 000 (prepareCall; в GUI не гоняли) |
| `anthropic/claude-opus-5.5` | 200 000 | `~15.6K / 200K` |
| `openai/gpt-5.6-luna` | 922 000 | `~7.7K / 922K` |
| `z-ai/glm-5.3-flash` (шлюз ёмкость не отдаёт) | — | `~10.3K / 131K` → дефолт |

До фикса та же сессия показывала `~10.8K / 131K` для `deepseek-flash` → теперь 1M: автокомпакт
v4-pro больше не режется на ~104k.

**Факт: `maxTokens` тоже применяется (0.3.2).** `buildProfile` заполняет
`configuredMaxTokens` из каталога (`lib/gateway-route.js:138-142`), поэтому `PiAiAdapter.modelInfo`
(`dsh-llm-pi-ai/lib/index.js:1911-1926`) отдаёт `defaultMaxTokens`. Проверено `prepareCall`
(адаптер маршрута, живой шлюз):

| id | `context.contextWindow` | `model.defaultMaxTokens` |
|---|---|---|
| `deepseek/deepseek-v4-pro` | 1 000 000 | 393 216 |
| `anthropic/claude-opus-5.5` | 200 000 | 64 000 |
| `openai/gpt-5.6-luna` | 922 000 | 128 000 |
| `z-ai/glm-5.3-flash` (в шлюзе нет полей) | 131 072 | поля `defaultMaxTokens` НЕТ вовсе (не 32768) |

В `/api/state` → `models.limits` = 6 записей `id → {contextWindow, maxTokens}`
(`index.js:3231`); у модели без полей шлюза записи нет. Профильные дефолты
(`defaultContextWindow: 131072`, `defaultMaxTokens: 32768`, `lib/gateway-route.js:128-129`) —
только фон, в подготовленный вызов они не протекают.

## 12. Маршрут не поднялся: gate остаётся единственным фильтром

Это запасной режим (0.3.x): если свой маршрут не поднялся (`llmProvider` пуст, нет
`ctx.llm.registerAdapter`, ошибка импорта pi-ai, конфликт §8), работает `installModelGate`
(`index.js:2056`, вызывается `index.js:3921`): он оборачивает `llm.listModels` и сужает каталог
до прав ключа. Тогда селектор = **каталог llm-pi-ai ∩ права ключа**, а не каталог маршрута.

Проверено фактом в двух вариантах:
* `llmProvider` пуст / `modelSync` выключен → журнал `models: own route not installed (…) Причина`
  (`index.js:2097-2104`), селектор живёт на статическом списке, суженном gate'ом;
* конфликт §8 → селектор = ровно статический список (1 модель), хотя права ключа — 62 модели.

Практический вывод: в запасном режиме пользователь видит только те id, что объявлены статически;
ёмкости и `reasoning_effort` там тоже статические (262K вместо 131072 и без Level-Map).

## 13. Ограничения v1 и диагностические пробелы

1. **`reasoning: true` для ВСЕХ id** (`lib/gateway-route.js:46-47`) при `profile.reasoning = 'low'`
   (`:125`), `thinkingLevelMap` = `{off:'low', low, medium, high, minimal:null, xhigh:null, max:null}`
   (`:31`). В GUI выбор Effort = Off/Low/Medium/High (в 0.3.1 меню было Low/Medium/High). `reasoning_effort:"low"` уходит в тело у всех моделей и шлюз его
   ПРИНИМАЕТ: 12+ id разных семейств ответили без 400 (проверено и перехватом тела). Значит
   `compat.supportsReasoningEffort: false` по моделям вводить не нужно.
2. **`reasoningEffort: 'off'` больше не падает (0.3.2).** В 0.3.1 `THINKING_LEVEL_MAP.off = null`
   давал `UNSUPPORTED_REASONING_EFFORT` (`dsh-llm-pi-ai/lib/index.js:1785-1789`); теперь
   `off: 'low'` (`lib/gateway-route.js:31`) и `resolveReasoningLevel('off')` → `low`. Проверено
   на живом шлюзе: `deepseek/deepseek-v4-pro`, `tencent/hy3`, `z-ai/glm-5.3-flash`,
   `anthropic/claude-opus-5.5` с `reasoningEffort: 'off'` → `stop` + текст, ни одного исключения.
   В `prepareCall` список уровней теперь `[off, low, medium, high]`, `defaultEffort: 'low'`.
   ВАЖНО: семантика — «off» только в имени; на провод уходит `reasoning_effort:"low"`, и модели
   продолжают отдавать reasoning-дельты (v4-pro: 69 дельт). Настоящего выключения размышлений
   маршрут не даёт.
3. **`cost: 0` для всех** (`:49`) → стоимость в GUI нулевая.
4. **`input: ['text']` для всех** (`:48`) → картинки проецируются в текст
   (`dsh-llm/lib/index.js:2337`), vision-модели шлюза работают без картинок.
5. **Кэш промпта не запрашивается**: `supportsLongCacheRetention:false` + `cacheRetention:'short'`
   (`:53,126`) → `prompt_cache_key` не уходит (`openai-completions.js:578-583`); `stream_options`
   уходит всегда (`:585-587`) и шлюзом принимается.
6. **Пустые `modelErrors`** (`:137`) → per-model диагностики `INVALID_CONFIG` нет.
7. **Журнал про каталог — исправлено в 0.3.2.** Строка стала
   `models: own route "dshlab" registered, api=openai-completions (каталог живой: getModels)`
   (`index.js:2162`), счётчика моделей в ней нет (раньше он врал: `catalog=0` печатался до discovery).
8. **`/api/state` — частично исправлено в 0.3.2.** Появились `models.route`
   `{provider:"dshlab", installed:true, api:"openai-completions", models:62}` и `models.limits`
   (6 записей `id → {contextWindow, maxTokens}`, `index.js:3231`). Осталось: `liveProviders` и
   `liveCatalog` = `null` (сервис `llm` не попал в опцию плагина) — по ним нельзя увидеть каталог
   живого llm-сервиса, только снимок самого плагина.
9. **Поведение при неудачном discovery** — «держим прежний каталог» (§6): UI продолжает показывать
   старые модели, хотя `keyState: error`. Если это нежелательно — обнулять каталог при `401`
   (одна ветка в discovery).
10. **Чужие поломки шлюза, не наши:** все `yandex/*` → `401` от LiteLLM («Unknown api key
    'AQVN****sY-z'», сломанный Yandex-ключ в самом шлюзе), `xiaomi/mimo-v2.5` → `404` OpenRouter
    guardrail («provider-not-allowed-by-guardrail»). Классифицируются как `AUTH`/`PI_AI_ERROR`,
    к `reasoning_effort` отношения не имеют.

## Приложение A. Матрица краевых прогонов (2026-10-27)

Стенд `/tmp/edge-cases.mjs`: фейковый шлюз на 3110 (HTTP-классы, обрыв, зависание) + живой шлюз
(повтор, отмена) + маршрут без ключа.

| Случай | Результат |
|---|---|
| `edge-ok` | 2 дельта, текст «tok0 tok1», `finish {kind:"stop"}` |
| `edge-401` | `error` code `AUTH` |
| `edge-403` | `error` code `AUTH` |
| `edge-429` | `error` code `RATE_LIMIT` |
| `edge-500` | `error` code `SERVER` |
| `edge-empty` (finish без контента) | `error` code `EMPTY_RESPONSE` |
| `edge-drop` (сокет рвётся в середине) | частичный текст + `error` code `TRANSPORT` |
| `edge-hang` + abort через 2 с | `aborted` code `ABORTED` (без зависания) |
| `edge-slow` + abort после 2 дельт | `aborted` code `ABORTED`, частичный текст |
| маршрут без ключа | `LlmError MISSING_CREDENTIAL` |
| живой `deepseek/deepseek-flash` ×2 | оба `stop`, текст совпадает (форма потока разная) |
| `prepareCall` неизвестного id | `LlmError UNKNOWN_MODEL` |
| `listModels` без ключа | `[]` |
| `providerInfo` | `{id:"dshlab", name:"LiteLLM (ключ DSH)"}` |
| `retryPolicy` маршрута | normal, 5 попыток, 500→10000 мс, jitter 0.1 |

## Результаты живого прогона (2026-10-27, :3091) — команда → результат

| Проверка | Команда/файл | Цифры факта |
|---|---|---|
| каталог и токен | `bash /tmp/edge-state-summary.sh` | `allowed` 62, `keyState` ok, `phase` ready |
| ёмкости | GUI: кнопка «N% of context used» → диалог | 1M / 200K / 922K / 131K (см. §11) |
| reasoning_effort в теле | `/tmp/edge-forward-proxy.mjs` + `/tmp/edge-body-probe.mjs` | `reasoning_effort:"low"`, `max_completion_tokens`, нет `prompt_cache_key` |
| приём reasoning_effort шлюзом | `/tmp/edge-re-probe2.mjs` | 12+ моделей `finish stop`, ни одного 400 |
| мусорный токен | `/tmp/edge-lab-api.sh` + GUI | `401`, каталог удержан, ход `AUTH` |
| смена токена | `POST /verme-gate/api/active` | 46 → 62 без рестарта |
| двойной рестарт | `bash /tmp/edge-restart.sh` ×2 | одна строка регистрации на старт |
| конфликт в патче | правка `profiles/web/cordis.patch.yml` | `already registered` + 1 модель в селекторе |
| отмена | GUI «Stop generating» | статус Stopped, частичный текст |
| краевая матрица | `/tmp/edge-cases.mjs` | см. Приложение A |
| `maxTokens` из шлюза (0.3.2) | `/tmp/edge-032-probe.mjs` (`prepareCall`) | v4-pro 393216, opus 64000, luna 128000, glm — поля нет |
| новый журнал (0.3.2) | журнал плагина | `registered, api=openai-completions (каталог живой: getModels)` |
| новые поля state (0.3.2) | `python3 /tmp/edge-state-032.py` | `route.models=62`, `limits` = 6 записей |
| `reasoningEffort:'off'` (0.3.2) | `/tmp/edge-off-probe.mjs` | 4 модели `stop`+текст, без `UNSUPPORTED_REASONING_EFFORT` |
| выбор вне прав нового ключа (0.3.2) | лаб-патч `tokens[].models` + `/api/active` | `allowed=1`, `reselect`+`default model persisted`, отправка ок |

## Приложение C. Что НЕ проверено фактом

| # | Пробел | Почему |
|---|---|---|
| 1 | фактическое число ретраев 429/5xx и паузы в журнале агента | живой шлюз таких ответов не даёт; стенд ретраи не исполняет (это уровень `dsh-llm-retry`) |
| 2 | 300-секундный idle-таймаут | слишком долго для прогона |
| 3 | `UNKNOWN_MODEL` при выборе вне прав — не воспроизводится | плагин переставляет выбор и персистит его раньше отправки (§5); нужен агент, поднятый до подмены каталога |
| 4 | живые 403 (нет прав на модель) | селектор не предложит чужой id, а прямой выбор требует правки патча |
| 5 | ветка конфликта «плагин зарегистрировался раньше llm-pi-ai» | порядок загрузки фиксирован бандл-слоем |
| 6 | HMR-перезагрузка плагина (без рестарта юнита) | не проверяли, только рестарт юнита |
| 7 | vision/картинки через маршрут | у всех моделей `input:['text']` — проверять нечего, это объявленное ограничение |
| 8 | live `maxTokens` (выход) | не применяется (см. §11) — сначала правка `configuredMaxTokens`, потом проверка |
