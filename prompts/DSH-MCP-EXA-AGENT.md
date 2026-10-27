# ИНСТРУКЦИЯ АГЕНТУ: подключить к DSH MCP Exa (веб-поиск через шлюз LiteLLM)

Цель: добавить в конфиг DSH MCP-сервер Exa по streamable-http — `exa` (веб-поиск,
продвинутый поиск, чтение страниц через hosted Exa за шлюзом LiteLLM), проверить связь
и откатиться при ошибке. Выполняй сам, STOP уважай строго.

## Данные подключения
1) serverName: exa   URL: https://ai-labs-litellm.verme.ru/exa/mcp
   3 тула: exa-web_search_exa, exa-web_search_advanced_exa, exa-web_fetch_exa
Транспорт: streamable-http.  Заголовок: Authorization: Bearer <виртуальный ключ LiteLLM>

- Ключ — виртуальный ключ RU-шлюза LiteLLM, у которого ЕСТЬ грант MCP-сервера `exa`
  (предусловие ниже). В примерах он обозначен `$EXA_KEY`; фактически лежит в
  `~/host/litellm-<alias>.key` (права 600) или в `~/.dsh/.credentials.yaml`. В репозиторий
  и в этот документ ключ не копировать.
- Почему путь `/exa/mcp`, а не `/mcp`: `/mcp` отдаёт ВСЕ тулы, разрешённые ключу
  (у ключа команды `ai_developer` их 141) и раздувает системный промпт. `/exa/mcp`
  (эквивалент — `/mcp/exa`) отдаёт ровно 3 тула exa. Проверено на проде 2026-10-14.
- Имя сервера в DSH (`serverName`) задаёт префикс тулов: `mcp__exa__exa-web_search_exa`,
  `mcp__exa__exa-web_search_advanced_exa`, `mcp__exa__exa-web_fetch_exa` (в чистом случае имя
  собирается дословно; если оно длиннее 64 символов или выходит за `[A-Za-z0-9_-]`, харнесс
  нормализует его и дописывает 12-hex хэш идентичности — здесь такого нет).

## Предусловие: у ключа есть грант exa (выдаёт владелец шлюза, не ты)
Ключ, состоящий в команде, наследует MCP-серверы команды: сначала exa выдаётся команде
(`POST /team/update` → `object_permission.mcp_servers`), затем — при необходимости — самому
ключу (`POST /key/update`). Ключу нельзя выдать сервер, которого нет у его команды:
ответ `403 "Key requests MCP servers not allowed by team ..."`.

Сервер `exa` в реестре: `server_id = b0d0068e-2e55-4506-b479-141d836bb9e0`.
Рядом живёт отдельный сервер `exa_agent` (многошаговый ресёрч одним вызовом, дороже) —
это ДРУГАЯ дверь и ДРУГОЙ грант; без отдельной просьбы его не выдавать.

## Шаг 0. Найти целевой файл
MCP-серверы DSH объявляются строками `@deepseek-ai/dsh-mcp-client` в патч-слое:
  - задан `DSH_HOME` -> `$DSH_HOME/cordis.patch.yml`
  - иначе Linux/macOS `~/.dsh/cordis.patch.yml`, Windows `%USERPROFILE%\.dsh\cordis.patch.yml`
Сверь фактическое место: `dsh --profile web --dump-config | grep -B2 -A8 'dsh-mcp-client'`
(`--dump-config` — флаг верхнего уровня `dsh`, у подкоманды `dsh web` его нет).
Файл не найден -> STOP: "патч-слой DSH не найден, ничего не менял".

## Шаг 1. Бэкап
Скопируй патч-файл в `<файл>.bak-mcp-exa-<YYYYMMDD-HHMMSS>` рядом. Любая ошибка после
этого шага -> восстанови файл из бэкапа и сообщи об откате.

## Шаг 2. Идемпотентность
`grep -n 'id: mcp-exa' <файл>` -> уже есть -> не дублируй, пропусти блок и переходи к
проверке (шаг 6).

## Шаг 3. Добавить в КОНЕЦ файла блок (пробелы, не Tab)
```yaml
# MCP Exa через шлюз LiteLLM (server-скоуп /exa/mcp): веб-поиск и чтение страниц.
# Ключ — виртуальный ключ RU-шлюза с грантом exa; файл патч-слоя держать 600.
- insert:
    - id: mcp-exa
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: exa
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/exa/mcp
        headers:
          Authorization: 'Bearer <EXA_KEY>'
        toolCallTimeoutMs: 120000
        failOnStartupError: false
        reconnect:
          enabled: true
          initialDelayMs: 2000
          maxDelayMs: 30000
          maxAttempts: 30
```

Альтернатива для секрета (если ключ нельзя писать в файл) — подстановка из окружения
процесса `dsh web` (`!!js` вычисляется загрузчиком конфига):
```yaml
        headers:
          Authorization: !!js '`Bearer ${process.env.LITELLM_EXA_KEY}`'
```

## Шаг 4. Проверить ключ и эндпоинт ДО правки конфига
Ожидание: `initialize` -> HTTP 200, `tools/list` -> ровно 3 тула `exa-*`.
Если 401/403 — ключ недействителен или без гранта: STOP и сообщи (конфиг не трогать).
```bash
EXA_KEY=$(cat ~/host/litellm-<alias>.key | tr -d '\r\n')   # или взять из ~/.dsh/.credentials.yaml
BASE=https://ai-labs-litellm.verme.ru/exa/mcp
curl -s -D /tmp/exa.h -o /dev/null -X POST "$BASE" \
  -H "Authorization: Bearer $EXA_KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
SID=$(tr -d '\r' < /tmp/exa.h | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')   # без него tools/list не ответит
curl -s -X POST "$BASE" -H "Authorization: Bearer $EXA_KEY" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | grep -o '"name":"[^"]*"'
```

## Шаг 5. Перечитать конфиг
Патч-слой DSH (и профильный, и корневой `$DSH_HOME/cordis.patch.yml`) **live-watched**:
сохранение файла горячо применяет изменение к запущенному `dsh web`, рестарт не нужен.
Если тулы не появились:
  - проверь синтаксис YAML (`python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" <файл>`);
  - перезапусти боевой DSH тем же способом, каким он запущен (`~/bin/dsh-web-lan`, `dsh web`);
  - горячий перезапуск плагинов требует смены кэш-бастера в поле `name` (загрузчик diff-ит `name`).

## Шаг 6. Проверка результата
1. В списке тулов появились 3 записи: `mcp__exa__exa-web_search_exa`,
   `mcp__exa__exa-web_search_advanced_exa`, `mcp__exa__exa-web_fetch_exa`.
2. Смоук-вызов: `mcp__exa__exa-web_search_exa` с аргументами `query` И `objective`
   (`objective` — ОБЯЗАТЕЛЬНОЕ поле текущей схемы; без него приходит
   «Input validation error: 'objective' is a required property»):
   `{"query": "asyncio documentation official", "objective": "найти офиц. документацию asyncio", "numResults": 3}`
   -> должны прийти ссылки с заголовками (`exa-web_fetch_exa` требует `urls`, `exa-web_search_advanced_exa` — `query`).
3. Ошибка `failOnStartupError` в логе -> смотри шаг 4 (ключ/сеть/прокси), не правь промпт.

## Шаг 7. Откат
1. Удали добавленный блок `- id: mcp-exa` (или восстанови файл из бэкапа шага 1).
2. Ключ/гранты не трогай — они на стороне шлюза и от конфига DSH не зависят.
3. Сообщи: "MCP Exa отключён, конфиг вернулся к состоянию <бэкап>".

## Грабли (проверено на проде)
- **Путь `/mcp` не использовать**: отдаёт все серверы ключа (141 тул у командного ключа) —
  промпт раздувается, растёт цена и растёт шанс, что модель уйдёт не в тот инструмент.
- **Два сервера с именем `exa` в реестре шлюза.** В UI LiteLLM видны обе записи:
  config-запись `46d4c0d79ca155ba0abecbb1ee6091f4` и запись из БД `b0d0068e-2e55-4506-b479-141d836bb9e0`
  (та, на которую ссылаются гранты ключей). Это не два разных сервиса, а один и тот же
  `https://.../mcp` за shim-ом; гранты выдавать по `b0d0068e-...`.
- **403 при выдаче гранта ключу в команде** — не баг прав, а отсутствие сервера у команды;
  сначала команда, потом ключ. После правки команды возможен краткий «залипший» 403:
  повтор через минуту либо `POST /cache/delete {"keys":["team_id:<team_uuid>"]}`.
- **TLS-прокси**: RU-шлюз ходит в интернет только через KZ-egress (haproxy :12330 → squid :64511).
  Если exa отвечает ошибкой на стороне шлюза — это egress, а не ключ и не DSH.
- **`exa_agent`** (`/exa_agent/mcp`) — отдельный, дорогой сервер (usage-based). Подключать
  только по отдельной просьбе и с отдельным грантом.

## Что уже сделано со стороны шлюза (2026-10-14)
- Команде `ai_developer` (`9c631265-6bc8-4eee-b2c9-6638cf4834bc`) выдан сервер `exa`
  (`object_permission.mcp_servers += exa`, группы `core,common,tr,tr-ext` сохранены).
- Ключу `a-onuts-generalpurpose` (тот же сервер, тулы `web_search_exa`,
  `web_search_advanced_exa`, `web_fetch_exa`) выдан грант уровня ключа.
- Проверено сквозняком: временный ключ в этой команде видит ровно 3 тула exa на `/exa/mcp`
  (временный ключ удалён).
- Проверка конфига DSH (2026-10-14): блок подключали тестовым ключом `tmp-dsh-exa-probe`
  (только exa, $1/7д) — (1) оверлеем `dsh --profile headless --patch exa-probe.yml`, (2) в живой
  `dsh web` через live-watch патч-слоя. Гейтвей зафиксировал `list_mcp_tools` этим ключом
  через 4 с после записи блока, вызов `exa-web_search_exa` вернул реальные результаты (cost $0.007).
- ⚠️ Файл `~/host/litellm-a-onuts-generalpurpose.key` (значение `sk-23nc4…i0Og`) **не
  аутентифицируется на проде**: `POST /v1/models` -> 401, sha256 `6c58ae82…d43c91`
  в таблице ключей отсутствует. Живая запись ключа — `a-onuts-generalpurpose`
  (sha256 `6b03606f…16a1b6`), её значение никому не выдано. Перед подключением в DSH ключ
  нужно перевыпустить (`POST /key/regenerate`) или запросить актуальное значение.
