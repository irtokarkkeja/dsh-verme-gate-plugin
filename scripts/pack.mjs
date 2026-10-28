/**
 * pack.mjs — собрать дистрибутив verme-gate для установки без доступа к GitHub.
 *
 * Что пакуется: рантайм плагина — index.js, lib/, client/, prompts/, page.html,
 * cordis.patch.yml, README.md, package.json — и релизный гейт: selftest.mjs, scripts/ и test/.
 * Набор = package.json "files" МИНУС dev-каталоги (docs/).
 *
 * Почему prompts/page.html/cordis.patch.yml — рантайм, хотя в задаче названы лишь index.js/lib/client:
 *   - prompts/   — плагин читает каталог встроенных промптов (index.js: BUNDLED_PROMPTS_DIR = ./prompts/);
 *   - page.html  — легаси-маршрут страницы настроек (index.js: readFile(new URL('./page.html', ...)));
 *   - cordis.patch.yml — bundle-слой плагина (package.json dsh.bundle.patch); без него DSH
 *     не подключит плагин как бандл (тот самый «скипнут гейтом»), и установка из тарбола
 *     ведёт себя иначе, чем из GitHub-тега.
 * Проверка полноты — в конце скрипта: в архиве обязаны быть все элементы REQUIRED.
 *
 * Запуск:
 *   node scripts/pack.mjs                          # dist/verme-gate-<version>.tgz из рабочего дерева
 *   node scripts/pack.mjs --from-tag v0.3.25       # ровно содержимое тега (то, что даёт github:…#vX)
 *   node scripts/pack.mjs --out /tmp               # в указанный каталог
 *   node scripts/pack.mjs --list                   # только показать, что попадёт в архив
 *
 * Зачем --from-tag: раздача обязана совпадать с тегом. Тарбол из рабочего дерева с
 * несохранёнными правками — это уже другой артефакт (так v0.3.24 уехал в зеркало со старым
 * клиентским бандлом: 110 939 вместо 126 702 байт). Проверка версии и размеров — ниже.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Каталог плагина (на уровень выше scripts/). fileURLToPath: на Windows pathname даёт "/C:/...". */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

/** Обязательные в рантайме пути: без любого из них установка из тарбола не эквивалентна GitHub-тегу. */
const REQUIRED = ['index.js', 'lib', 'client', 'prompts', 'page.html', 'cordis.patch.yml', 'README.md', 'package.json']

/**
 * scripts/, test/ и selftest.mjs — не «рантайм плагина», а релизный гейт: приёмка по инструкции
 * распаковывает тарбол и гоняет `node selftest.mjs`, который читает scripts/release.mjs,
 * scripts/build-client.mjs и прогоняет негативные тесты аварийной записи credential-store из test/.
 * Без них гейт падает на распакованном артефакте (проверено), а в зеркале GitHub эти каталоги
 * есть — значит и тарбол обязан их содержать, иначе два пути установки не эквивалентны.
 */
const REQUIRED_EXTRA = ['selftest.mjs', 'scripts', 'test']

/** Никогда не пакуем: артефакты разработки и лабы. */
const EXCLUDE = ['docs', 'node_modules', 'dist', '.git', '.plugin-manager']

/**
 * Вложенные пути, которые вырезаем даже из scripts/: в раздаче их быть не должно.
 * lab/ — лаб-прогоны; pack.mjs — сам этот упаковщик (иначе тарбол из дерева никогда не совпадёт
 * с тарболом из тега: в теге упаковщика нет). Плагину для работы они не нужны.
 */
const ALWAYS_DROP = ['scripts/lab', 'scripts/pack.mjs']

/** Разобрать argv: --out <dir>, --from-tag <ref>, --list, -h. */
function parseArgs(argv) {
  const options = { out: join(PLUGIN_DIR, 'dist'), list: false, fromTag: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = argv[++index] || options.out
    else if (arg === '--from-tag') options.fromTag = argv[++index] || ''
    else if (arg === '--list') options.list = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('node scripts/pack.mjs [--out <dir>] [--from-tag <ref>] [--list]\n')
      process.exit(0)
    } else throw new Error('неизвестный аргумент: ' + arg)
  }
  return options
}

/** Запустить команду, вернув stdout; ошибку — с хвостом вывода. */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = String((error && error.stderr) || '')
    throw new Error(command + ' ' + args.join(' ') + ' упал: ' + (stderr || String(error)))
  }
}

/** Есть ли такой ref (тег/коммит) в указанном git-репозитории. */
function hasRef(repoDir, ref) {
  try {
    run('git', ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], repoDir)
    return true
  } catch {
    return false
  }
}

/**
 * Источник времени для воспроизводимого архива: SOURCE_DATE_EPOCH, иначе время коммита.
 * Для --from-tag берём время коммита ТЕГА: иначе mtime зависит от текущего HEAD репозитория и
 * две сборки одного тега дают разные sha (так разошлись сборки 0.3.27 у меня и у Lead).
 */
function buildEpoch(ref) {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH)
  const mirror = process.env.VERME_GATE_MIRROR_DIR || join(tmpdir(), 'dsh-verme-gate-plugin')
  const candidates = ref ? [PLUGIN_DIR, mirror] : [PLUGIN_DIR]
  for (const dir of candidates) {
    try {
      if (ref && !hasRef(dir, ref)) continue
      return Number(run('git', ['log', '-1', '--format=%ct', ref || 'HEAD'], dir))
    } catch {
      // пробуем следующий репозиторий
    }
  }
  return Math.floor(Date.now() / 1000)
}

/** sha256 файла. */
async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

/** Человекочитаемый размер. */
function human(bytes) {
  return bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(2) + ' МБ' : Math.round(bytes / 1024) + ' КБ'
}

const options = parseArgs(process.argv.slice(2))
const manifest = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'))
const name = String(manifest.name || '')
const version = String(manifest.version || '')
if (name !== 'verme-gate') throw new Error('ожидался пакет verme-gate, а в package.json: ' + name)
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('версия не в виде X.Y.Z: ' + version)

const present = []
for (const entry of [...REQUIRED, ...REQUIRED_EXTRA]) {
  if (existsSync(join(PLUGIN_DIR, entry))) present.push(entry)
}
const missing = [...REQUIRED, ...REQUIRED_EXTRA].filter((entry) => !present.includes(entry))
if (missing.length > 0) throw new Error('в плагине нет обязательных путей: ' + missing.join(', '))

if (options.list) {
  process.stdout.write('в архив ' + name + '@' + version + ' попадут:\n')
  for (const entry of present) process.stdout.write('  ' + entry + '\n')
  process.stdout.write('исключены: ' + EXCLUDE.join(', ') + '\n')
  process.exit(0)
}

const staging = await mkdtemp(join(tmpdir(), 'verme-gate-pack-'))
try {
  // npm-совместимый архив: файлы лежат в package/, поэтому pnpm ставит тарбол как обычный пакет.
  const root = join(staging, 'package')
  await mkdir(root, { recursive: true })
  if (options.fromTag !== '') {
    // Содержимое берём из git-объектов тега: ровно то, что приедет через github:…#vX.
    // Тег живёт либо в монорепо (путь плагина = plugins/dsh-mcp-access), либо в standalone-клоне
    // зеркала (файлы в корне) — ищем в обоих, чтобы проверка работала и у автора, и у релизёра.
    const archive = join(staging, 'tag.tar')
    const mirror = process.env.VERME_GATE_MIRROR_DIR || join(tmpdir(), 'dsh-verme-gate-plugin')
    if (hasRef(PLUGIN_DIR, options.fromTag)) {
      const top = run('git', ['rev-parse', '--show-toplevel'], PLUGIN_DIR)
      const prefix = PLUGIN_DIR.slice(top.length + 1)
      run('git', ['archive', '--format=tar', '--output=' + archive, options.fromTag,
        ...present.map((entry) => prefix + '/' + entry)], top)
      run('tar', ['-xf', archive, '-C', root, '--strip-components=' + prefix.split('/').length], staging)
    } else if (existsSync(mirror) && hasRef(mirror, options.fromTag)) {
      run('git', ['archive', '--format=tar', '--output=' + archive, options.fromTag, ...present], mirror)
      run('tar', ['-xf', archive, '-C', root], staging)
    } else {
      throw new Error('тег ' + options.fromTag + ' не найден ни в ' + PLUGIN_DIR + ', ни в ' + mirror
        + ' (укажите клон зеркала через VERME_GATE_MIRROR_DIR)')
    }
  } else {
    for (const entry of present) {
      await cp(join(PLUGIN_DIR, entry), join(root, entry), { recursive: true, preserveTimestamps: true })
    }
  }
  // Проверка артефакта до упаковки: обнулённый/устаревший клиентский бандл уезжал в раздачу молча
  // (инцидент 2026-10-28: в теге v0.3.24 клиент был 110 939 Б вместо 126 702 Б — без чипа обновления).
  const clientBundle = await readFile(join(root, 'client/index.cjs'), 'utf8')
  if (clientBundle.length < 2000 || !/exports\.apply\s*=/.test(clientBundle)) {
    throw new Error('client/index.cjs подозрительно пуст (' + clientBundle.length + ' байт): не пакую — сверься с тегом')
  }
  const builtClient = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!builtClient.includes('verme-gate ' + version)) {
    throw new Error('lib/client.js собран не из этой версии (ожидался баннер «verme-gate ' + version + '»): пересобери node scripts/build-client.mjs')
  }
  for (const drop of ALWAYS_DROP) {
    await rm(join(root, drop), { recursive: true, force: true })
  }
  // Права нормализуем: рабочие файлы бывают 0600, у git-тега — 0644; иначе одинаковое содержимое
  // даёт разные байты архива и «несовпадающий sha256» на пустом месте.
  run('chmod', ['-R', 'u+rwX,go+rX,go-w', root], staging)
  const epoch = buildEpoch(options.fromTag)
  const tarballName = name + '-' + version + (options.fromTag === '' ? '' : '-tag') + '.tgz'
  const outDir = options.out
  await mkdir(outDir, { recursive: true })
  const tarball = join(outDir, tarballName)
  run('tar', [
    '-czf', tarball,
    '--sort=name',
    '--owner=0', '--group=0', '--numeric-owner',
    '--mtime=@' + epoch,
    '-C', staging,
    'package',
  ], PLUGIN_DIR)
  const listing = run('tar', ['-tzf', tarball], PLUGIN_DIR).split('\n').filter((line) => line !== '')
  const inside = new Set(listing.map((line) => line.replace(/^package\//, '').split('/')[0]))
  const absent = [...REQUIRED, ...REQUIRED_EXTRA].filter((entry) => !inside.has(entry))
  if (absent.length > 0) throw new Error('в архиве нет: ' + absent.join(', '))
  const leaked = listing.filter((line) => [...EXCLUDE, ...ALWAYS_DROP]
    .some((entry) => line === 'package/' + entry || line.startsWith('package/' + entry + '/')))
  if (leaked.length > 0) throw new Error('в архив попали dev-пути: ' + leaked.slice(0, 5).join(', '))
  const info = await stat(tarball)
  process.stdout.write('собран ' + tarball + '\n')
  process.stdout.write('  версия:  ' + version + (options.fromTag === '' ? '' : ' (из тега ' + options.fromTag + ')') + '\n')
  process.stdout.write('  размер:  ' + human(info.size) + ' (' + info.size + ' байт)\n')
  process.stdout.write('  sha256:  ' + (await sha256(tarball)) + '\n')
  process.stdout.write('  файлов:  ' + listing.filter((line) => !line.endsWith('/')).length + '\n')
  process.stdout.write('  mtime:   @' + epoch + ' (для воспроизводимости: SOURCE_DATE_EPOCH=' + epoch + ')\n')
  // Манифест по файлам: sha256 архива зависит от tar/gzip окружения, поэтому сверять сборки
  // между машинами надёжнее по содержимому — он и печатается рядом с архивом.
  const manifest = []
  for (const entry of listing.filter((line) => !line.endsWith('/'))) {
    manifest.push((await sha256(join(root, entry.replace(/^package\//, '')))) + '  ' + entry.replace(/^package\//, ''))
  }
  manifest.sort()
  await writeFile(tarball + '.manifest.txt',
    '# verme-gate ' + version + ' — содержимое архива (сверка между машинами)\n'
    + '# mtime @' + epoch + ', файлов ' + manifest.length + '\n' + manifest.join('\n') + '\n')
  process.stdout.write('  манифест: ' + tarball + '.manifest.txt\n')
  process.stdout.write('установка:\n  dsh plugin --profile web add file:' + tarball + '\n')
} finally {
  await rm(staging, { recursive: true, force: true })
}
