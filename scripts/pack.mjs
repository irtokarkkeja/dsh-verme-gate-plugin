/**
 * pack.mjs — собрать дистрибутив verme-gate для установки без доступа к GitHub.
 *
 * Что пакуется: только рантайм плагина — index.js, lib/, client/, prompts/, page.html,
 * cordis.patch.yml, README.md, selftest.mjs и package.json. Набор = package.json "files"
 * МИНУС dev-каталоги (scripts/, test/, docs/): они нужны только для разработки и релиза.
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
 *   node scripts/pack.mjs                # dist/verme-gate-<version>.tgz
 *   node scripts/pack.mjs --out /tmp     # в указанный каталог
 *   node scripts/pack.mjs --list         # только показать, что попадёт в архив
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Каталог плагина (на уровень выше scripts/). */
const PLUGIN_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/** Обязательные в рантайме пути: без любого из них установка из тарбола не эквивалентна GitHub-тегу. */
const REQUIRED = ['index.js', 'lib', 'client', 'prompts', 'page.html', 'cordis.patch.yml', 'README.md', 'package.json']

/** Необязательные, но полезные: selftest гоняется коллегой при приёмке. */
const OPTIONAL = ['selftest.mjs']

/** Никогда не пакуем: dev-обвязка, артефакты лабы и служебные каталоги. */
const EXCLUDE = ['scripts', 'test', 'docs', 'node_modules', 'dist', '.git', '.plugin-manager']

/** Разобрать argv: --out <dir>, --list, -h. */
function parseArgs(argv) {
  const options = { out: join(PLUGIN_DIR, 'dist'), list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = argv[++index] || options.out
    else if (arg === '--list') options.list = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('node scripts/pack.mjs [--out <dir>] [--list]\n')
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

/** Источник времени для воспроизводимого архива: время последнего коммита или SOURCE_DATE_EPOCH. */
function buildEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH)
  try {
    return Number(run('git', ['log', '-1', '--format=%ct'], PLUGIN_DIR))
  } catch {
    return Math.floor(Date.now() / 1000)
  }
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
for (const entry of [...REQUIRED, ...OPTIONAL]) {
  if (existsSync(join(PLUGIN_DIR, entry))) present.push(entry)
}
const missing = REQUIRED.filter((entry) => !present.includes(entry))
if (missing.length > 0) throw new Error('в плагине нет обязательных для рантайма путей: ' + missing.join(', '))

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
  for (const entry of present) {
    await cp(join(PLUGIN_DIR, entry), join(root, entry), { recursive: true, preserveTimestamps: true })
  }
  const epoch = buildEpoch()
  const tarballName = name + '-' + version + '.tgz'
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
  const absent = REQUIRED.filter((entry) => !inside.has(entry))
  if (absent.length > 0) throw new Error('в архиве нет: ' + absent.join(', '))
  const leaked = listing.filter((line) => EXCLUDE.some((entry) => line.startsWith('package/' + entry)))
  if (leaked.length > 0) throw new Error('в архив попали dev-пути: ' + leaked.slice(0, 5).join(', '))
  const info = await stat(tarball)
  process.stdout.write('собран ' + tarball + '\n')
  process.stdout.write('  версия:  ' + version + '\n')
  process.stdout.write('  размер:  ' + human(info.size) + ' (' + info.size + ' байт)\n')
  process.stdout.write('  sha256:  ' + (await sha256(tarball)) + '\n')
  process.stdout.write('  файлов:  ' + listing.filter((line) => !line.endsWith('/')).length + '\n')
  process.stdout.write('установка:\n  dsh plugin --profile web add file:' + tarball + '\n')
} finally {
  await rm(staging, { recursive: true, force: true })
}
