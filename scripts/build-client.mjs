/**
 * Сборка клиентской половины: оборачивает client/index.cjs в формат загрузчика DSH.
 *
 * DSH грузит клиентские плагины как готовые бандлы window.__ModuleLoader__.load({id, factory}),
 * где require отдаёт только seed-модули платформы (react, react/jsx-runtime, примитивы UI).
 * Исходник — обычный CommonJS без JSX, поэтому сборка сводится к обёртке.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const source = await readFile(new URL('../client/index.cjs', import.meta.url), 'utf8')
// Пустой/усечённый исходник проходит проверку синтаксисом (пустой файл — валидная программа),
// и тогда собирается «валидный» бандл без клиента: экран настроек исчезает без единой ошибки.
// Инцидент 2026-10-28: client/index.cjs обнулился параллельной записью, сборка прошла молча.
if (source.trim().length < 2000 || !/exports\.apply\s*=/.test(source)) {
  console.error('client/index.cjs подозрительно пуст (' + source.length + ' байт): отказываюсь собирать'
    + ' — проверь, не обнулил ли файл параллельный процесс (git checkout -- client/index.cjs)')
  process.exit(1)
}
// Синтаксис проверяем до записи: битый бандл валит загрузку всех плагинов в клиенте.
try {
  new Function('exports', 'module', 'require', source)
} catch (error) {
  console.error('client/index.cjs не компилируется: ' + error.message)
  process.exit(1)
}
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const header = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name) + ', factory: (require) => {'
  + ' var module = { exports: {} }; var exports = module.exports;'
  + ' Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });'
const footer = 'return module.exports; } });'

const banner = '/* ' + manifest.name + ' ' + manifest.version + ' — сгенерировано scripts/build-client.mjs, не редактировать вручную. */'

await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), banner + '\n' + header + '\n' + source + '\n' + footer + '\n')
console.log('lib/client.js собран из client/index.cjs')
// Ловушка dev-стенда: DSH читает имя плагина и ревизию клиента при старте, а браузер получает
// готовый граф строк (id -> url). Если инстанс поднят из рабочего дерева (path-плагин) и его не
// перезапустить, новая сборка регистрируется под новым id, а граф ждёт старый: в консоли
// «loaded without registering "<id>" via __ModuleLoader__.load» и «Failed to load plugins».
console.warn('если DSH запущен из рабочего дерева (path-плагин), перезапусти инстанс: '
  + 'имя плагина и клиентский граф кешируются на старте')
