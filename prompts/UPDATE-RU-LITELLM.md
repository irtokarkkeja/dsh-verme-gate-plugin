# Перевод DSH-бандла на RU LiteLLM + thinking-режим для GLM

> Для коллег с выданным dsh-bootstrap (Windows). Две правки в одном файле —
> `settings.yaml`. Ключ трогать НЕ нужно: все ключи перенесены на RU и работают
> как раньше (проверено на боевом бандл-ключе 2026-09).

## Что меняем и зачем

1. **URL шлюза**: старый NL `https://static.60.127.91.77.ip.webhost1.net:8096/v1`
   будет выключен после миграции. Новый адрес — RU-шлюз
   `https://ai-labs-litellm.verme.ru/v1`.
2. **Thinking-режим GLM**: GLM 5.3 Flash — reasoning-модель. В бандле выбора
   уровня рассуждения не было; добавляем уровни low / medium / high
   (в GUI DSH появится переключатель у модели).

## Инструкция (2 минуты)

1. Закройте DSH (окно чата / PowerShell с `dsh web`).
2. Откройте файл `%USERPROFILE%\.dsh\settings.yaml` в Блокноте
   (Win+R → `%USERPROFILE%\.dsh` → settings.yaml → правый клик → «Открыть с помощью» → Блокнот).
3. Найдите строку:

   ```yaml
   baseURL: https://static.60.127.91.77.ip.webhost1.net:8096/v1
   ```

   и замените её на:

   ```yaml
   baseURL: https://ai-labs-litellm.verme.ru/v1
   ```

4. Сразу ПОД строкой `apiKeyEnv: LITELLM_API_KEY` (с тем же отступом, 6 пробелов)
   добавьте строку дефолтного уровня thinking:

   ```yaml
   reasoning: low
   ```

5. В блоке модели `z-ai/glm-5.3-flash` после строки `maxTokens: 131072`
   добавьте (соблюдайте отступы — пробелы, не Tab):

   ```yaml
        reasoningEfforts:
          low: low
          medium: medium
          high: high
        compat:
          thinkingFormat: openrouter
   ```

6. Сохраните файл, запустите `dsh web` заново.

## Как должно выглядеть целиком

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

## Проверка

- Чат отвечает как раньше — значит URL и ключ в порядке.
- В селекторе модели у GLM появился выбор уровня thinking (low/medium/high).
- low — быстрее и дешевле; high — глубже рассуждение, больше токенов.

## Если что-то пошло не так

- **Ошибка «Reasoning is mandatory for this endpoint and cannot be disabled»** —
  пропущен шаг 4 (`reasoning: low`): без дефолтного уровня DSH пытается выключить
  рассуждение, а апстрим этого не позволяет.
- **Отступы**: YAML чувствителен к пробелам — сравните с блоком «как должно выглядеть».
- **Не открывается / нет сети**: старый NL-адрес пока ещё работает как запасной,
  но после его отключения чат без этой правки встанет.