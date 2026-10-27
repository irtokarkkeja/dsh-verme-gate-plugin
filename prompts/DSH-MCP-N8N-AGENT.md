# ИНСТРУКЦИЯ АГЕНТУ: MCP-сервер n8n в DSH

Ты — агент, которому человек отдал этот файл. Выполни шаги сам, в конце прогони приёмку и
покажи результат. Всё, что в угловых скобках `<…>` — подставляет человек (это секрет);
ничего не выдумывай, чужие токены не подставляй.

Проверено на живом проде 2026-10-21: n8n **2.29.10**, `https://ai-labs-n8n.verme.ru`,
instance-level MCP включён (`settings: mcp.access.enabled=true`), сервер отдаёт **33 тула**.

Есть два разных MCP-эндпоинта n8n — выбери нужный:

| | Instance-level MCP (рекомендуется) | MCP Server Trigger (один воркфлоу) |
|---|---|---|
| URL | `https://ai-labs-n8n.verme.ru/mcp-server/http` | `https://ai-labs-n8n.verme.ru/mcp/verme-gateway` |
| Авторизация | `Authorization: Bearer <персональный токен>` | `Authorization: Bearer <секрет креденшела ноды>` |
| Токен | у каждого свой, из UI | один статический секрет на всех |
| Тулы | 33 (поиск/чтение/запуск/сборка воркфлоу, data tables) | 1 — `Doc_Actualization` |
| Кому | тому, кому нужен n8n как рабочий инструмент | тому, кому нужен только запуск актуализации доков |

Ниже — основной путь (instance-level). Вариант с гейтвеем — в разделе 6.

## 0. Что получится

DSH-агент умеет работать с n8n как с MCP-сервером (33 тула):

- **Найти и прочитать воркфлоу**: `search_workflows`, `get_workflow_details`,
  `get_workflow_history`, `get_workflow_version`, `list_tags`, `search_projects`, `search_folders`;
- **Запустить воркфлоу и посмотреть результат**: `execute_workflow` (возвращает executionId
  сразу, не ждёт), `get_execution`, `search_executions`;
- **Собрать/изменить воркфлоу из кода (SDK)**: `get_sdk_reference`, `search_nodes`,
  `get_node_types`, `explore_node_resources`, `get_workflow_best_practices`,
  `validate_node_config`, `validate_workflow`, `create_workflow_from_code`, `update_workflow`,
  `publish_workflow`, `unpublish_workflow`, `archive_workflow`, `restore_workflow_version`;
- **Тестовые прогоны на pin-данных**: `prepare_test_pin_data`, `test_workflow`;
- **Data tables**: `search_data_tables`, `create_data_table`, `rename_data_table`,
  `add_data_table_column`, `rename_data_table_column`, `delete_data_table_column`, `add_data_table_rows`;
- плюс ресурс `n8n://workflow-sdk/reference` (справочник Workflow SDK).

Важное свойство: **токен персональный**. Агент видит и делает ровно то, что доступно владельцу
токена в n8n, и действует от его имени. Токен владельца инстанса не переиспользовать.

## 1. Предпосылки

1. У человека есть аккаунт в n8n: вход на `https://ai-labs-n8n.verme.ru` (SAML SSO корп-учёткой,
   аккаунт заводится при первом входе). Роль `member` достаточно: право `mcpApiKey:create`
   и `mcpApiKey:rotate` есть у member; `mcp:manage` (глобальное включение MCP) — только
   owner/admin, но на инстансе оно уже включено.
2. У человека есть доступ **к тем воркфлоу, которые нужны агенту**: MCP-тулы работают под
   правами владельца токена и не открывают воркфлоу чужих проектов. Нужный воркфлоу владелец
   должен расшарить человеку (n8n → Workflow → Share) и держать включённым тумблер
   **Available in MCP** (Workflow menu → Settings → Available in MCP) — это флаг видимости
   для MCP (на проде включён у «Verme MCP Gateway» и «Merged Code → Doc Actualization Draft»).
3. DSH уже установлен. Ничего не переустанавливаем — правим только его конфиг.

## 2. Шаг 1: взять свой персональный токен n8n

1. Открыть `https://ai-labs-n8n.verme.ru` → **Settings → Instance-level MCP**.
2. **Connect a client → вкладка API key**: n8n сам создаёт персональный токен учётки при первом
   открытии вкладки. Скопировать **Server URL** и токен (или готовый Configuration JSON с заголовком
   `Authorization: Bearer …`).
3. Токен показывается один раз: после ухода с вкладки остаётся только маска. Потерялся —
   там же кнопка **Rotate** (старый токен отзывается сразу).

Проверка, что токен живой и что видно все тулы (подставить свой токен; ничего не печатать в чат):

```bash
TOKEN='<токен n8n>'
curl -s -X POST https://ai-labs-n8n.verme.ru/mcp-server/http \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"dsh","version":"0"}}}' | head -c 300
curl -s -X POST https://ai-labs-n8n.verme.ru/mcp-server/http \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | grep -o '"name":"[a-z_]*"' | wc -l
```

Ожидание: `initialize` → 200 и `serverInfo.name = "n8n MCP Server"`; `tools/list` → **33** тула.
401 «Unauthorized» = токен неверный/отозван; 403 = нет доступа к MCP у учётки.

Особенности endpoint-а (проверено):
- он **стателесс**: `mcp-session-id` не выдаётся и не нужен, каждый POST самодостаточен;
- `Accept` обязан содержать `text/event-stream`, иначе **406** (ответы — SSE, строки
  `event: message` + `data: {json}`);
- лимит `N8N_MCP_SERVER_RATE_LIMIT` — 100 запросов на IP; за общим IP (сервер, раннер) квота
  расходуется на всех, признак — 429 и заголовки `X-RateLimit-*`.

## 3. Шаг 2: добавить сервер в DSH

Конфиг: `$DSH_HOME/cordis.patch.yml`, иначе `~/.dsh/cordis.patch.yml`
(Windows: `%USERPROFILE%\.dsh\cordis.patch.yml`). Это **список верхнего уровня** — блок
дописывается в конец файла, отступы пробелами (2), без табов.

Сначала бэкап и проверка, что блока ещё нет:

```bash
cp ~/.dsh/cordis.patch.yml ~/.dsh/cordis.patch.yml.bak-n8n-$(date +%Y%m%d-%H%M)
grep -n 'id: mcp-n8n' ~/.dsh/cordis.patch.yml   # пусто = блока нет
```

Дописать в конец:

```yaml
# n8n как MCP-сервер (instance-level, 33 тула): поиск/чтение/запуск воркфлоу, сборка из SDK.
# Токен персональный: Settings → Instance-level MCP → Connect a client → API key.
- insert:
    - id: mcp-n8n
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: n8n
        transport: streamable-http
        url: https://ai-labs-n8n.verme.ru/mcp-server/http
        headers:
          Authorization: 'Bearer <токен n8n>'
        toolCallTimeoutMs: 180000
        failOnStartupError: false
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}
```

- `toolCallTimeoutMs: 180000` — `execute_workflow`/`get_execution` бывают медленными;
  дефолт 60 с мало.
- Токен вписывается строкой (файл держать `600`). Вариант «через переменную окружения»
  (`Authorization: !!js '\`Bearer \${process.env.N8N_MCP_TOKEN}\`'`) работает только если переменная
  реально есть в окружении запуска DSH: `.credentials.yaml` в `process.env` не выгружается.
- Префикс тулов задаёт `serverName`: будут `mcp__n8n__search_workflows` и т. д.

Проверить YAML и перезапустить (патч-слой обычно подхватывается сам за считанные секунды,
рестарт нужен, если строка не появилась):

```bash
python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1],encoding='utf-8'))" ~/.dsh/cordis.patch.yml
dsh web            # Windows: в том же терминале, где обычно запускается DSH
```

## 4. Приёмка

1. `/mcp` в чате DSH → строка `n8n` со статусом **connected** и **33** тулами.
2. Смоук (read-only): попросить агента вызвать `mcp__n8n__search_workflows` с `{"limit": 10}` →
   список превью воркфлоу с полем `availableInMCP`.
3. Смоук с запуском (только если владелец разрешил и есть доступный воркфлоу):
   `mcp__n8n__get_workflow_details {"workflowId": "<id>", "detailLevel": "execution"}` →
   `mcp__n8n__execute_workflow {"workflowId": "<id>", "executionMode": "manual"}` →
   `mcp__n8n__get_execution {"executionId": "<id>", "workflowId": "<id>"}`.

## 5. Как этим пользоваться (типовые задачи)

| Задача | Тулы по порядку |
|---|---|
| «Что за воркфлоу X, как его запускают» | `search_workflows` → `get_workflow_details` (у него есть `triggerInfo` — как запускать) |
| «Запусти воркфлоу и покажи результат» | `execute_workflow` → `get_execution` (`includeData: true` — с данными нод) |
| «Почему упал последний прогон» | `search_executions` (фильтр по `workflowId`/`status`) → `get_execution` |
| «Откати воркфлоу к прошлой версии» | `get_workflow_history` → `get_workflow_version` → `restore_workflow_version` |
| «Сделай/поправь воркфлоу» | `get_sdk_reference` (обязательно первым) → `get_node_types` → `validate_workflow` → `create_workflow_from_code`/`update_workflow` → `publish_workflow` |
| «Что за нода и какие у неё параметры» | `search_nodes` → `get_node_types` → `explore_node_resources` |

Правила, которые стоит соблюдать агенту:

- **Не запускать прод-воркфлоу без явной просьбы.** `execute_workflow` — реальный запуск с
  побочными эффектами (письма, задачи, вебхуки). Для проверки — `executionMode: "manual"` и
  `test_workflow` на pin-данных.
- **Сначала читать, потом писать.** Изменение воркфлоу (`update_workflow`,
  `create_workflow_from_code`) — это правка прода; показывать diff/итог человеку.
- Чужие воркфлоу не трогать: если `search_workflows` его не вернул — доступа нет, это не баг.

## 6. Границы и чем этот путь отличается от других MCP

- Это **не** доступ к самому n8n-инстансу как администратору: тулы работают под правами
  пользователя токена, админ-операции (креденшелы, пользователи, переменные) недоступны
  (`list_credentials` отдаёт только имена/ids, секретов не возвращает).
- Второй, «воркфлоу-скоуп» вариант — нода **MCP Server Trigger** внутри одного воркфлоу
  (у нас это `Verme MCP Gateway`): URL `https://ai-labs-n8n.verme.ru/mcp/verme-gateway`
  (не `/mcp-server/…`!), авторизация — `Authorization: Bearer <секрет креденшела ноды>`,
  сессионный (выдаёт `mcp-session-id`, его надо возвращать), отдаёт **один** тул
  `Doc_Actualization` (входы: `days` = 7, `branch` = dev) → прогон `Merged Code → Doc Actualization Draft`.
  Без заголовка — 403 «Authorization data is wrong!» (через публичный edge тело ошибки подменяется
  HTML-страницей, диагностировать надо изнутри VM). Секрет — один статический на всех, поэтому
  для нескольких людей он хуже персонального токена; подключать так:

  ```yaml
  - insert:
      - id: mcp-n8n-gateway
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: n8n-gateway
          transport: streamable-http
          url: https://ai-labs-n8n.verme.ru/mcp/verme-gateway
          headers:
            Authorization: 'Bearer <секрет креденшела MCP Verme Gateway>'
          toolCallTimeoutMs: 300000
          reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}
  ```

- Флаг `Available in MCP` (у нас включён у `Verme MCP Gateway` и `Merged Code → Doc Actualization Draft`)
  **не добавляет тулов** в `/mcp-server/http`: он только помечает воркфлоу как видимый для MCP.
  Воркфлоу запускаются через `execute_workflow(workflowId)` (или через их собственный mcpTrigger-URL).
- **Не** подключать через LiteLLM-гейтвей (`https://ai-labs-litellm.verme.ru/n8n/mcp`):
  на 2026-10-21 эта запись нерабочая (шлюз не может аутентифицироваться в n8n: `auth_type: api_key`
  шлёт `X-API-Key`, а n8n ждёт `Authorization: Bearer`; к тому же LiteLLM 1.100.1 не резолвит
  `os.environ/` в `auth_value`). Прямое подключение из DSH — рабочий путь; гейтвей починят
  отдельно (шим по образцу `exa-mcp-shim` + грант сервера ключу).

## 7. Если не завелось

| Симптом | Причина / что делать |
|---|---|
| `/mcp`: `n8n` в статусе error, тулов 0 | токен неверный/отозван → `tools/list` curl-ом (шаг 1); перевыпустить токен и поправить конфиг |
| 401 «Unauthorized: Authorization header not sent» | заголовок не доехал: проверить, что ключ `headers.Authorization` и значение начинается с `Bearer ` |
| 401 «Unauthorized» | токен чужой/просроченный/отозван (у каждого свой) |
| Тулы есть, но `search_workflows` пусто | нет доступа к воркфлоу: попросить владельца поделиться (Share) |
| Воркфлоу находится, `execute_workflow` отказывает | у воркфлоу выключен **Available in MCP** или нет права execute |
| Строка `n8n` не появилась после правки | YAML невалиден (проверить `yaml.safe_load`), либо DSH не перечитал файл → перезапустить |

## 8. Владельцу платформы: что нужно сделать на стороне n8n и LiteLLM

1. **Аккаунт.** Коллеги в n8n ещё нет (пользователей 7: `sad@nesss.ru` owner, `i.anyshkevich`/
   `v.usmanov@verme.ru` admin, остальные member). Вход по SAML SSO сам создаст member-учётку;
   отдельного приглашения не требуется.
2. **Доступ к воркфлоу.** Расшарить нужные воркфлоу его учётке (Workflow → Share) и оставить
   `Available in MCP` включённым. Иначе агент получит тулы, но пустой `search_workflows`.
3. **Сервисный пользователь (рекомендуется, если n8n нужен нескольким людям или гейтвею).**
   Завести в n8n отдельного пользователя (`dsh-agent@…`), выдать ему доступ к нужным воркфлоу и
   взять его персональный MCP-токен. Тогда действия агентов не смешиваются с личной учёткой owner:
   сейчас единственный действующий MCP-токен принадлежит `sad@nesss.ru` (владелец инстанса) —
   делиться им нельзя, это полные права на все воркфлоу (включая create/update/publish).
4. **Плечо LibreChat сломано тем же токеном.** В `deploy/stack/.env` переменная `N8N_MCP_TOKEN`
   испорчена (181–183 симв., 2 сегмента JWT, хвост `>` вместо нормального 3-сегментного ключа
   на 272 симв.) → n8n отвечает 401, в логах LibreChat `[MCP][n8n] … Unauthorized` и
   `Failed to connect after 3 attempts`. Лечится заменой значения на действующий ключ из
   `user_api_keys` (audience `mcp-server-api`) или на токен сервисного пользователя.
5. **LiteLLM-путь** (`https://ai-labs-litellm.verme.ru/n8n/mcp`) починить, если нужен доступ
   через гейтвей: (а) положить валидный `N8N_MCP_TOKEN` в `deploy/stack/litellm/litellm.env`
   (в контейнере его нет вообще — там `env_file` именно этот файл); (б) LiteLLM 1.100.1 не резолвит
   `os.environ/` в `auth_value`, поэтому нужен шим по образцу `exa-mcp-shim`, который сам ставит
   `Authorization: Bearer …`, а запись в конфиге перевести на `auth_type: none` + url шима;
   (в) `docker compose up -d --force-recreate litellm` (env_file впекается при создании контейнера);
   (г) выдать сервер ключам: `object_permission.mcp_servers` (`cd11f2e6a023e887300e9c919d3166aa`
   для n8n) — список заменяется целиком, существующие id сохранять; опционально сузить
   `mcp_tool_permissions` до read-only тулов.

Подготовлено 2026-10-21. Факты проверены на живом проде: 33 тула, `serverInfo.name = "n8n MCP Server"`
(версия сервера 1.1.0), n8n 2.29.10. Секретов в файле нет.
