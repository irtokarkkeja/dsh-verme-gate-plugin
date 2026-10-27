# АГЕНТ-ИНСТРУКЦИЯ: перевод DSH на RU LiteLLM + thinking-режим GLM

> Это промпт для ИИ-агента (DSH и др.), работающего на машине пользователя.
> Агент выполняет все шаги сам, без вопросов, кроме случаев, явно помеченных STOP.
> Отдай файл агенту целиком: «выполни инструкцию из этого файла».

## Цель

В конфиге DSH пользователя: (1) переключить LLM-шлюз с NL на RU,
(2) добавить модели GLM опцию уровней thinking (low/medium/high).
Ключ НЕ меняется — он уже работает на RU.

## Целевой файл

- Windows: `%USERPROFILE%\.dsh\settings.yaml`
- Linux/macOS: `~/.dsh/settings.yaml`

Если переменная окружения `DSH_HOME` установлена — использовать `$DSH_HOME/settings.yaml`.

## Шаг 0. Предпроверка

Прочитай `settings.yaml`. Найди секцию `llm-pi-ai.providers`.

- Если провайдера `verme-litellm` НЕТ — STOP: «конфиг не от бандла verme-litellm, ничего не менял».
- Если `baseURL` уже `https://ai-labs-litellm.verme.ru/v1` И в модели `z-ai/glm-5.3-flash` уже есть `reasoningEfforts` — STOP: «уже настроено, ничего не менял».

## Шаг 1. Бэкап

Скопируй `settings.yaml` в `settings.yaml.bak-<YYYYMMDD-HHMMSS>` рядом.
Все ошибки после этого шага → восстанови файл из бэкапа и сообщи об откате.

## Шаг 2. Замена URL

Замени строку:

```yaml
      baseURL: https://static.60.127.91.77.ip.webhost1.net:8096/v1
```

на:

```yaml
      baseURL: https://ai-labs-litellm.verme.ru/v1
```

(отступ — 6 пробелов, как в исходной строке).

## Шаг 3. Дефолтный уровень thinking

Сразу ПОСЛЕ строки `      apiKeyEnv: LITELLM_API_KEY` (с отступом 6 пробелов) вставь:

```yaml
      reasoning: low
```

Без этой строки DSH шлёт выключение рассуждения, а апстрим отвечает 400
«Reasoning is mandatory for this endpoint and cannot be disabled».

## Шаг 4. Thinking-опции модели GLM

В записи модели `z-ai/glm-5.3-flash` после строки `        maxTokens: 131072` вставь
(отступы строго как ниже; пробелы, не Tab):

```yaml
        reasoningEfforts:
          low: low
          medium: medium
          high: high
        compat:
          thinkingFormat: openrouter
```

## Шаг 5. Итоговый вид (сверь дословно)

```yaml
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
        reasoningEfforts:
          low: low
          medium: medium
          high: high
        compat:
          thinkingFormat: openrouter
      - id: deepseek/deepseek-v4-flash-0731
        contextWindow: 1048576
        maxTokens: 393216
```

Остальные секции файла (agent-default-model, ui-onboarding и т.п.) не трогай.

## Шаг 6. Валидация

1. Распарси YAML (python: `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" settings.yaml`,
   на Windows без python — любым доступным парсером; либо строгая глазами-сверка с шагом 5).
2. Прочитай ключ из `.credentials.yaml` в том же каталоге (поле `refs.LITELLM_API_KEY`)
   и проверь новый шлюз:

   ```
   GET https://ai-labs-litellm.verme.ru/v1/models
   Authorization: Bearer <ключ>
   ```

   Ожидание: HTTP 200, в списке есть `z-ai/glm-5.3-flash`.
   Windows PowerShell: `Invoke-RestMethod -Uri https://ai-labs-litellm.verme.ru/v1/models -Headers @{ Authorization = "Bearer <ключ>" }`
3. НЕ перезапускай DSH сам — агент работает внутри него.

## Шаг 7. Отчёт пользователю

Кратко: что изменено (URL, reasoning: low, reasoningEfforts), путь к бэкапу,
результат проверки шлюза, и фраза: **«Перезапусти DSH (`dsh web`), чтобы изменения вступили в силу;
в селекторе модели у GLM появятся уровни thinking low/medium/high»**.

## Известные особенности (не баги)

- Рассуждение у GLM-5.3-flash на этом шлюзе обязательное — уровня «off» нет и не будет.
- Редкий транзиент: шлюз может ответить 500/403 (апстрим-прокси) — повтори проверку шага 6 один раз.