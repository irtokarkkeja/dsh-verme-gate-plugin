/**
 * Модальность и ёмкости модели по записи `/model/info` шлюза LiteLLM.
 *
 * Зачем отдельный модуль. Ёмкости (окно/вывод) и приём картинок шлюз кладёт в разные места:
 * окно и вывод — обычно в `litellm_params`, но у моделей, заведённых в БД или объявленных через
 * `model_info`, они бывают только в `model_info`; флаг картинок (`supports_vision`) — почти
 * всегда `model_info`, изредка дублируется в `litellm_params`. Если модальность не разобрать,
 * pi-ai объявляет модель текстовой и DSH валит вложение картинки с UNSUPPORTED_CONTENT — при том
 * что шлюз картинки принимает.
 *
 * @module verme-gate/model-modality
 */

/**
 * Число из значения шлюза: пустое, нечисловое и неположительное — undefined.
 * Тип проверяется отдельно: Number(true) === 1 и Number([]) === 0 превращали бы мусор в лимит.
 */
const positive = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** Объект из значения шлюза: null, массивы и примитивы схлопываются в пустой объект. */
const record = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

/**
 * Прочитать ёмкости и модальность одной записи `/model/info`.
 *
 * Приоритет у `litellm_params`: это то, что шлюз применяет к запросу. `model_info` — запасное
 * место (и единственное для моделей, пришедших из БД).
 *
 * @param {object} entry - запись ответа `/model/info`.
 * @returns {{ contextWindow?: number, maxTokens?: number, vision: boolean }} ёмкости и приём картинок.
 */
export function readModelCapabilities(entry) {
  const source = record(entry)
  const params = record(source.litellm_params)
  const info = record(source.model_info)
  const contextWindow = positive(params.max_input_tokens) ?? positive(info.max_input_tokens)
  const maxTokens = positive(params.max_output_tokens) ?? positive(info.max_output_tokens)
  // Модальность: строго true. Шлюз отдаёт false/отсутствие для текстовых моделей, а строку
  // "true" не отдаёт вовсе — приведение через Boolean() тут только навредило бы (строка "false").
  const vision = params.supports_vision === true || info.supports_vision === true
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    vision,
  }
}
