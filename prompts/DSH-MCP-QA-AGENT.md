# ИНСТРУКЦИЯ АГЕНТУ: DSH + MCP-доступ QA-набора через шлюз Verme

Ты — агент, которому человек отдал этот файл (инструкция персональная: в неё уже подставлен
ключ получателя). Выполни шаги сам, в конце прогони приёмку и покажи результат. Всё, что в
угловых скобках `<…>`, — заглушки: значения даёт ЧЕЛОВЕК (шаг 5), не выдумывай их и не
подставляй чужие. Если чего-то не хватает — остановись и спроси.

Получатель (подставлено при выдаче): **`__KEY_ALIAS__`**, user_id `__USER_EMAIL__`.
**DSH у получателя уже установлен** — ничего не переустанавливаем, только правим конфиг.

## 0. Что получится

DSH-агент получает **6 MCP-серверов (66 тулов)** — набор роли `ai_qa` («как у тестировщиков»):
EvaTeam, PDM/Redmine, SQL по стендам, TestY, Sentry, запись в WFM.
Файловое рабочее пространство (`workspace`) сознательно НЕ подключаем.

| MCP-сервер | Тулов | Что даёт | Нужны ли личные креды |
|---|---|---|---|
| `evateam` | 13 | база знаний EvaTeam: чтение + семантический поиск | нет (сервисный токен в контейнере) |
| `redmine` | 12 | PDM: задачи, поиск, вложения, коммиты/PR | **да: `REDMINE_PERSONAL_KEY`** (шаг 5.1) |
| `sql` | 5 | SQL по стендам (read-only, по имени стенда) | нет |
| `testy` | 23 | TestY TMS: кейсы, сьюты, прогоны, результаты | **да: `TESTY_LOGIN`/`TESTY_PASSWORD`** (шаг 5.2) |
| `sentry` | 8 | Sentry: ошибки, события, релизы | нет (общая сервисная учётка, только чтение) |
| `wfmwrite` | 5 | WFM-стенды: список, вызов операции, запись | нет |

Группы гранта ключа: `core` (evateam, workspace, redmine, sql) + `qa` (testy, sentry) +
`wr-wfm` (wfmwrite); из группы `core` в DSH подключаем всё, кроме `workspace`. Ключ: бюджет **$10 / 30 дней**, guardrail `pii-round-trip`, alias
`__KEY_ALIAS__`. **Чего у ключа НЕТ и не будет без отдельной просьбы:** веб-поиск
(`exa`/`serper`), инфраструктура/SSH-портал (`devops`), запись SQL (`sqlwrite`), правки
EvaTeam (`evateamwrite`), GitHub/sandbox, TestLink/Bitrix, чтение WFM (сервер `wfm` группы
`common`) и фин-DWH. Понадобится — сказать владельцу ключа.

## 1. Подготовка: конфиг, бэкап, сеть

DSH ставить не нужно. Проверь только, что он живой: `dsh --version`.

Каталог конфига — `~/.dsh` (`%USERPROFILE%\.dsh` на Windows); если задана переменная
`DSH_HOME` — использовать её.

**Бэкап перед правками:** скопируй `settings.yaml` и `cordis.patch.yml` рядом в
`.bak-mcpqa-<дата>`. Отсутствие любого из этих файлов — не ошибка (создадим в шагах 2–4).

⚠️ Прокси: если на машине есть локальный прокси (v2rayN и подобное) и он выключен, DSH не
достучится до шлюза («fetch failed»). Перед работой:

- Windows: `$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:NO_PROXY='ai-labs-litellm.verme.ru,verme.ru,localhost,127.0.0.1'`
- Linux/macOS: `unset HTTP_PROXY HTTPS_PROXY; export NO_PROXY=ai-labs-litellm.verme.ru,verme.ru,localhost,127.0.0.1`

Строку NO_PROXY стоит внести и в системные переменные: тогда DSH ходит в шлюз мимо прокси всегда.

## 2. `~/.dsh/settings.yaml` (модели шлюза)

Если файла нет — создать; если есть — аккуратно дополнить провайдера `verme-litellm` до вида
(сохранив чужие ключи, если они были):

```yaml
agent-default-model:
  provider: verme-litellm
  model: z-ai/glm-5.3-flash

llm-pi-ai:
  providers:
    verme-litellm:
      displayName: Verme LiteLLM
      api: openai-completions
      baseURL: https://ai-labs-litellm.verme.ru/v1
      apiKeyEnv: LITELLM_API_KEY
      reasoning: low
      models:
      - id: z-ai/glm-5.3-flash
        contextWindow: 1310720
        maxTokens: 131072
        reasoningEfforts: {low: low, medium: medium, high: high}
        compat: {thinkingFormat: openrouter}
      - id: deepseek/deepseek-v4-flash-0731
        contextWindow: 1048576
        maxTokens: 131072
        reasoningEfforts: {low: low, medium: medium, high: high}
        compat: {thinkingFormat: openrouter}
      - id: deepseek/deepseek-v4.1-flash
        contextWindow: 1048576
        maxTokens: 131072
        reasoningEfforts: {low: low, medium: medium, high: high}
        compat: {thinkingFormat: openrouter}
      - id: GeneralPurpose
        contextWindow: 1048576
        maxTokens: 131072
        reasoningEfforts: {low: low, medium: medium, high: high}
        compat: {thinkingFormat: openrouter}
```

Проверь две вещи: `baseURL` = `https://ai-labs-litellm.verme.ru/v1` (если остался старый
NL-адрес — замени) и есть строка `reasoning: low` (без неё шлюз отвечает «Reasoning is mandatory
for this endpoint and cannot be disabled» — GLM reasoning-модель, полностью отключить нельзя).

## 3. Ключ доступа

Файл `~/.dsh/.credentials.yaml` (если есть — сохрани `.bak` и добавь ref, не затирая чужие):

```yaml
version: 1
refs:
  LITELLM_API_KEY: __LITELLM_KEY__
```

Права: `chmod 600 ~/.dsh/.credentials.yaml` (Windows: файл не выкладывать в git и чаты).
Проверка связи (должен вернуть JSON со списком моделей):

```
curl -s https://ai-labs-litellm.verme.ru/v1/models -H "Authorization: Bearer __LITELLM_KEY__"
```

Если `LITELLM_API_KEY` уже есть в файле и совпадает с ключом из этого документа — ничего не
меняй. Ключ персональный (`__KEY_ALIAS__`): не копируй его в другие документы и бандлы.

## 4. MCP-серверы (`cordis.patch.yml`)

MCP объявляются в патч-слое DSH — файл `cordis.patch.yml` рядом с `settings.yaml`
(`$DSH_HOME/cordis.patch.yml`, иначе `~/.dsh/cordis.patch.yml`; Windows —
`%USERPROFILE%\.dsh\cordis.patch.yml`). Если файла нет — создай пустой.

**4.1. Почему URL вида `/<server>/mcp`, а не `/mcp`.** Общий `https://ai-labs-litellm.verme.ru/mcp`
отдаёт ВСЕ тулы ключа (у этого ключа 95, в DSH подключаем 66) и раздувает системный промпт. Server-скоуп
`/evateam/mcp`, `/testy/mcp` и т.д. отдаёт тулы ровно одного сервера. Проверено на проде
2026-10-16.

**4.2. Добавить 6 блоков в конец файла** (отступы — пробелы, не табы):

```yaml
# EvaTeam: чтение + семантический поиск по базе знаний (13 тулов)
- insert:
    - id: mcp-evateam
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: evateam
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/evateam/mcp
        headers:
          Authorization: 'Bearer __LITELLM_KEY__'
        toolCallTimeoutMs: 120000
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}


# PDM/Redmine: задачи, поиск, вложения (12 тулов; нужен личный ключ PDM — шаг 5.1)
- insert:
    - id: mcp-redmine
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: redmine
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/redmine/mcp
        headers:
          Authorization: 'Bearer __LITELLM_KEY__'
        toolCallTimeoutMs: 120000
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}

# SQL по стендам, read-only (5 тулов)
- insert:
    - id: mcp-sql
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: sql
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/sql/mcp
        headers:
          Authorization: 'Bearer __LITELLM_KEY__'
        toolCallTimeoutMs: 120000
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}

# TestY TMS: кейсы, сьюты, прогоны (23 тула; нужны личные логин/пароль TestY — шаг 5.2)
- insert:
    - id: mcp-testy
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: testy
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/testy/mcp
        headers:
          Authorization: 'Bearer __LITELLM_KEY__'
        toolCallTimeoutMs: 120000
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}

# Sentry: ошибки и события (8 тулов)
- insert:
    - id: mcp-sentry
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: sentry
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/sentry/mcp
        headers:
          Authorization: 'Bearer __LITELLM_KEY__'
        toolCallTimeoutMs: 120000
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}

# WFM: список стендов, вызов операции, запись (5 тулов)
- insert:
    - id: mcp-wfmwrite
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: wfmwrite
        transport: streamable-http
        url: https://ai-labs-litellm.verme.ru/wfmwrite/mcp
        headers:
          Authorization: 'Bearer __LITELLM_KEY__'
        toolCallTimeoutMs: 120000
        reconnect: {enabled: true, initialDelayMs: 2000, maxDelayMs: 30000, maxAttempts: 30}
```

**4.3. Идемпотентность.** Перед вставкой проверь, что блоков ещё нет:
`grep -n 'id: mcp-evateam' ~/.dsh/cordis.patch.yml` (и так по каждому id). Уже есть — не дублируй.

**4.4. Проверить YAML и применить:**

```
python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1],encoding='utf-8'))" ~/.dsh/cordis.patch.yml
```

Патч-слой — live-watched: сохранение файла при запущенном `dsh web` подхватывается без
перезапуска (в чате `/mcp` покажет новые серверы). Если после правки серверы не появились —
перезапусти `dsh web`. Если сомневаешься в пути —
`dsh --profile web --dump-config | grep -B2 -A8 'dsh-mcp-client'` (это флаг верхнего уровня
`dsh`, у подкоманды `dsh web` его нет).

## 5. Что делает сам человек (заглушки) — НЕ заполняй за него

Ниже два секрета, которые агент НЕ должен узнавать, придумывать или куда-либо сохранять.
Спроси человека и подставь ровно в одну команду; значение в отчёт не печатай (пиши только
«зарегистрировано, is_set=true»). Если человек не хочет давать секрет в чат — дай ему ссылку
на самообслуживание (тот же результат, секрет не проходит через тебя).

| Заглушка | Кто даёт | Где взять | Куда идёт |
|---|---|---|---|
| `<PDM_TOKEN>` | человек | pdm.verme.ru → «Моя учётная запись» (`/my/account`) → «Ключ доступа к API» → «Показать» (нет ключа — «Сгенерировать») | шаг 5.1, только в POST на шлюз |
| `<TESTY_LOGIN>` `<TESTY_PASSWORD>` | человек | его личная учётка TestY (`https://testy.verme.ru`, HTTP Basic) | шаг 5.2, только в POST на шлюз |
| `__LITELLM_KEY__` | владелец шлюза | уже подставлен в этот файл | `~/.dsh/.credentials.yaml` + MCP-блоки |

### 5.1. PDM/Redmine: `REDMINE_PERSONAL_KEY`

Ключ PDM НЕ кладётся в конфиг DSH: он регистрируется пер-юзерно в шлюзе и подставляется на
стороне шлюза. Плейсхолдер встречается в команде РОВНО ОДИН РАЗ — внутри JSON; кавычки оставь:

```
curl -X POST https://ai-labs-litellm.verme.ru/v1/mcp/server/66dba6772701db6df84000c83cd224ca/user-env-vars \
  -H "Authorization: Bearer __LITELLM_KEY__" \
  -H "Content-Type: application/json" \
  -d '{"values":{"REDMINE_PERSONAL_KEY":"<PDM_TOKEN>"}}'
```

Самообслуживание (человек сам, без агента):
`https://ai-labs-litellm.verme.ru/ui/?page=mcp-servers&fill_env_vars=66dba6772701db6df84000c83cd224ca`

Проверка (приёмка шага): должен быть `"is_set": true`, `"missing_count": 0`:

```
curl -s https://ai-labs-litellm.verme.ru/v1/mcp/user-env-vars/status \
  -H "Authorization: Bearer __LITELLM_KEY__"
```

### 5.2. TestY: `TESTY_LOGIN` + `TESTY_PASSWORD`

```
curl -X POST https://ai-labs-litellm.verme.ru/v1/mcp/server/29f8af7579ca75fc78be0a7a46190eda/user-env-vars \
  -H "Authorization: Bearer __LITELLM_KEY__" \
  -H "Content-Type: application/json" \
  -d '{"values":{"TESTY_LOGIN":"<TESTY_LOGIN>","TESTY_PASSWORD":"<TESTY_PASSWORD>"}}'
```

Самообслуживание:
`https://ai-labs-litellm.verme.ru/ui/?page=mcp-servers&fill_env_vars=29f8af7579ca75fc78be0a7a46190eda`

**Пока переменные не заданы, ЛЮБОЙ вызов TestY (даже чтение) падает с текстом**
«Cannot connect to MCP server "testy" … you haven't set … TESTY_LOGIN, TESTY_PASSWORD». Это не
поломка ключа — не выполнен этот шаг. У Redmine аналогично с `REDMINE_PERSONAL_KEY`.

Правила обращения с секретами (не нарушать):
- Секрет подставляется только в команду шага 5.1/5.2. Не писать его в `settings.yaml`,
  `cordis.patch.yml`, `.credentials.yaml`, не сохранять в файлы, не печатать в ответе и логах.
- Смена/удаление: тот же POST с новым значением или `DELETE` на тот же URL.
- 401/403 при регистрации — секрет неверный или отозван: скажи человеку, сам ничего не
  перевыпускай и не подставляй «похожее».

## 6. Приёмка (прогнать и показать результат)

1. `curl -s https://ai-labs-litellm.verme.ru/v1/models -H "Authorization: Bearer __LITELLM_KEY__"` —
   список моделей, среди них `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4-flash-0731`,
   `deepseek/deepseek-v4.1-flash`, `GeneralPurpose`.
2. `dsh web` → чат http://127.0.0.1:3080 открывается, модель `z-ai/glm-5.3-flash` отвечает.
3. В чате `/mcp` → **шесть** строк в статусе connected с числом тулов 13 / 12 / 5 / 23 / 8 / 5.
4. Машинная проверка состава тулов (положи рядом `check-mcp.py` и запусти
   `python3 check-mcp.py ~/.dsh/.credentials.yaml`):

```python
# check-mcp.py — печатает число тулов каждого сервера; ожидание 13/12/5/23/8/5, сумма 66
# запуск: python3 check-mcp.py ~/.dsh/.credentials.yaml
import json, sys, urllib.request
BASE = "https://ai-labs-litellm.verme.ru"
KEY = open(sys.argv[1], encoding="utf-8").read().split("LITELLM_API_KEY:")[1].split()[0].strip()
H = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def rpc(url, method, params=None, sid=None):
    h = dict(H); h["Authorization"] = "Bearer " + KEY
    if sid: h["mcp-session-id"] = sid
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                                                       "params": params or {}}).encode(), headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw, ct = r.read().decode(), r.headers.get("Content-Type", "")
        sid = r.headers.get("mcp-session-id")
    if "text/event-stream" in ct:
        return json.loads([l[6:] for l in raw.splitlines() if l.startswith("data: ")][0]), sid
    return (json.loads(raw) if raw.strip() else {}), sid
total = 0
for srv in ["evateam", "redmine", "sql", "testy", "sentry", "wfmwrite"]:
    url = "%s/%s/mcp" % (BASE, srv)
    _, sid = rpc(url, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "check", "version": "1"}})
    rpc(url, "notifications/initialized", sid=sid)
    res, _ = rpc(url, "tools/list", sid=sid)
    n = len(res["result"]["tools"]); total += n
    print("%-10s %2d" % (srv, n))
print("TOTAL", total)
```

5. Живые вызовы в чате (по одному):
   - «найди в базе знаний EvaTeam регламент обработки инцидентов» → тул
     `mcp__evateam__evateam-evateam_semantic_search` → документы DOC-* со ссылками vermewfm.evateam.ru;
   - «покажи мои задачи в PDM» → `mcp__redmine__redmine-redmine_search` (**после 5.1**);
   - «кто я в TestY» → `mcp__testy__testy-testy_whoami` (**после 5.2**);
   - «кто я в Sentry» → `mcp__sentry__sentry-sentry_whoami`;
   - «список стендов WFM» → `mcp__wfmwrite__wfmwrite-wfm_stands`;
   - «какие есть БД на стенде dev» → `mcp__sql__sql-list_databases` (аргумент `stand` обязателен).

Если шаг 5 не выполнен — вызовы Redmine/TestY вернут текст про per-user variables: так и
доложить («видно, но не активировано до кред человека»), это НЕ ошибка настройки.

## 7. Что доступно (66 тулов)

**EvaTeam (13, только чтение):** `evateam_semantic_search` (семантический поиск — основной),
`evateam_get_document`, `evateam_browse_documents`, `evateam_get_path`, `evateam_get_attachments`,
`evateam_get_comments`, `evateam_check_document`, `evateam_find_person`, `evateam_list_tags`,
`evateam_list_projects`, `evateam_count`, `evateam_describe_model`, `evateam_rpc`.


**PDM/Redmine (12):** `redmine_search`, `redmine_request`, `redmine_issue_github_urls`,
`redmine_paths_list`, `redmine_paths_info`, `redmine_download`, `redmine_upload`,
`redmine_whoami`, `redmine_create_issue`, `redmine_add_note`, `redmine_update_issue`,
`ep_redmine_extension_settings`.

**SQL (5):** `list_databases`, `list_tables`, `get_table_schema`, `execute_select`, `search_objects`.

**TestY (23):** `testy_whoami`, `testy_search_cases`, `testy_get_case`, `testy_list_cases`,
`testy_create_case`, `testy_update_case`, `testy_copy_case`, `testy_archive_case`,
`testy_get_case_history`, `testy_restore_case_version`, `testy_add_comment`, `testy_add_result`,
`testy_get_results`, `testy_browse_suites`, `testy_create_suite`, `testy_update_suite`,
`testy_list_projects`, `testy_list_statuses`, `testy_list_labels`,
`testy_list_custom_attributes`, `testy_get_testplan`, `testy_list_plan_tests`,
`testy_upload_attachment`.

**Sentry (8):** `sentry_whoami`, `sentry_list_projects`, `sentry_list_issues`,
`sentry_get_issue`, `sentry_issue_stats`, `sentry_list_events`, `sentry_get_event`,
`sentry_list_releases`.

**WFM write (5):** `wfm_stands`, `wfm_list_ops`, `wfm_describe_op`, `wfm_call`, `wfm_refresh`.

## 8. Если что-то не работает

- **Не видны MCP-тулы** → проверь путь патч-слоя (`dsh --profile web --dump-config | grep -A8 dsh-mcp-client`)
  и что файл лежит рядом с `settings.yaml` (`$DSH_HOME` учитывается).
- **401/403 от шлюза** → ключ отозван или исчерпан бюджет ($10/30 дней). Не перевыпускай сам,
  сообщи владельцу ключа.
- **«fetch failed»/таймаут** → прокси: NO_PROXY-строка из шага 1 + перезапуск `dsh web`.
- **«Reasoning is mandatory…»** → потерялась строка `reasoning: low` в `settings.yaml`.
- **Redmine/TestY «require per-user variables»** → не выполнен шаг 5 (кред человека нет).
- **0 тулов у сервера** → у ключа нет нужной группы; сверь `object_permission.mcp_access_groups`
  (`curl -s https://ai-labs-litellm.verme.ru/key/info?key=<alias> -H "Authorization: Bearer <мастер-ключ>"`) —
  изменение групп делает владелец шлюза.
- **Красная строка одного сервера в `/mcp`** → остальные работают; мешающий сервер можно убрать
  из `cordis.patch.yml` и перезапустить DSH.
- **Откат целиком** → вернуть `settings.yaml`/`cordis.patch.yml` из бэкапов шага 1, перезапустить.

## 9. Границы и предупреждения

- Ключ персональный: не пересылать, не класть в git и общие чаты — с него идёт расход и им
  подписан доступ к 7 серверам. Расход и отзыв — в дашборде
  `https://ai-labs-litellm.verme.ru/ui/` (Virtual Keys → `__KEY_ALIAS__`).
- **Sentry ходит под ОБЩЕЙ сервисной учёткой** (`v.kolokolov@verme.ru`, scopes read-only), не под
  личной: не считай его персональной атрибуцией.
- **Правки WFM (`wfm_call` с write-операцией) идут под сервисной учёткой контейнера** — личная
  атрибуция в этом канале не реализована; для рабочих правок согласуй с командой WFM.
- **`workspace` намеренно не подключён** (файловое рабочее пространство не нужно).
  Понадобится — сказать владельцу ключа: сервер разрешён группой `core`, достаточно
  добавить блок в патч-слой (шаг 4.2) и перезапустить DSH.
- **Запись в EvaTeam этим ключом недоступна** (группа `wr-eva` не выдана), SQL — только чтение.
- Персональные секреты (PDM-ключ, TestY) живут только в шлюзе (шаг 5) и принадлежат человеку:
  агент их не хранит, не логирует и не пересылает.
