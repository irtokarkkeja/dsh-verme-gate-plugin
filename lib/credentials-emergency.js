/**
 * Аварийная правка одного ref'а в файле credential-store ($DSH_HOME/.credentials.yaml).
 *
 * Зачем отдельным модулем: на штатной остановке сервис credentials-local уже закрыт, а durable-снимок
 * обязан вернуться в ref (R2-b). Правка идёт в обход сервиса, поэтому вся ответственность за
 * целостность чужого содержимого файла — здесь: чужие ref'ы, комментарии и порядок ключей должны
 * переживать нашу запись, а битый YAML — не перезаписываться вообще (fail-closed).
 *
 * Логика чистая: парсер/сериализатор и файловые операции приходят снаружи, поэтому гонки и отказы
 * проверяются юнит-тестами (test/credentials-emergency.test.mjs).
 */

/** Сколько раз перечитывать файл, если он меняется под нами (fallback без блокировки). */
const DEFAULT_ATTEMPTS = 5

/**
 * Записать/удалить ref в документе credential-store, не задевая чужие данные.
 * Документ не мутируется: возвращается копия.
 *
 * @param {object} document - разобранный документ store.
 * @param {string} ref - имя ref'а.
 * @param {string} value - значение; пустая строка — удалить ref.
 * @returns {object} новый документ.
 */
export const mergeRef = (document, ref, value) => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('документ credential-store не объект')
  }
  const refs = document.refs !== null && typeof document.refs === 'object' && !Array.isArray(document.refs)
    ? { ...document.refs }
    : {}
  if (value === '') delete refs[ref]
  else refs[ref] = value
  const next = { ...document }
  next.refs = refs
  if (next.version === undefined) next.version = 1
  return next
}

/**
 * Прочитать файл, применить правку и записать его под блокировкой.
 *
 * Инварианты (каждый — отдельный тест):
 * 1. чтение выполняется ВНУТРИ withLock: иначе read-modify-write вне lock теряет чужую запись;
 * 2. файл перечитывается непосредственно перед записью: если он изменился — начинаем заново,
 *    а не затираем чужое содержимое своим устаревшим снимком;
 * 3. битый YAML не перезаписывается (fail-closed), ошибка возвращается вызывающему;
 * 4. ok=true только после readback-проверки: наш ref принял значение, чужие ref'ы на месте.
 *
 * @param {{ withLock: (fn: () => Promise<object>) => Promise<object>, readText: () => Promise<string>,
 *   writeText: (text: string) => Promise<void>, parse: (text: string) => object,
 *   stringify: (document: object) => string, ref: string, value: string, attempts?: number }} options
 * @returns {Promise<{ok: boolean, refs: number, error: string}>} результат.
 */
export const applyRefWithLock = async ({ withLock, readText, writeText, parse, stringify, ref, value, attempts = DEFAULT_ATTEMPTS }) => {
  return await withLock(async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const text = await readText()
      let document
      try {
        document = text.trim() === '' ? { version: 1 } : parse(text)
      } catch (error) {
        // Битый файл не переписываем: снимок остаётся в store, восстановление повторится на старте.
        return { ok: false, refs: 0, error: 'credential-store не разбирается: ' + String(error && error.message ? error.message : error) }
      }
      const before = document && typeof document === 'object' && document.refs ? { ...document.refs } : {}
      let next
      try {
        next = mergeRef(document, ref, value)
      } catch (error) {
        return { ok: false, refs: 0, error: String(error && error.message ? error.message : error) }
      }
      // Пункт 2: снимок должен быть снят с актуального файла — иначе чужая запись потеряется.
      if (await readText() !== text) continue
      await writeText(stringify(next))
      // Пункт 4: проверяем, что запись реально применилась и чужое не потеряно.
      const after = parse(await readText())
      const afterRefs = after && after.refs && typeof after.refs === 'object' ? after.refs : {}
      const expected = value === '' ? undefined : value
      const got = typeof afterRefs[ref] === 'string' ? afterRefs[ref] : undefined
      const lost = Object.keys(before).filter((other) => other !== ref && afterRefs[other] !== before[other])
      if (got !== expected) return { ok: false, refs: Object.keys(afterRefs).length, error: 'readback mismatch' }
      if (lost.length > 0) return { ok: false, refs: Object.keys(afterRefs).length, error: 'потеряны чужие refs: ' + lost.join(',') }
      return { ok: true, refs: Object.keys(afterRefs).length, error: '' }
    }
    return { ok: false, refs: 0, error: 'файл credential-store меняется под нами (гонка писателей)' }
  })
}
