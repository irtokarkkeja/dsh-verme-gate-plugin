/**
 * Один шаг вместо ручного ритуала выпуска: версия → сборка клиента → selftest → коммит →
 * пуш в gitlab и в публичное зеркало плагина (`github:irtokarkkeja/dsh-verme-gate-plugin`).
 *
 * Почему скрипт, а не память: у обновления плагина нет автоматики в DSH (проверено на 0.2.1-rc.2:
 * `dsh plugin` — это только форвард в pnpm, никакого «обнови себя»), поэтому единственное место,
 * где может жить порядок шагов — этот файл.
 *
 * Запуск:
 *   node scripts/release.mjs --bump minor -m 'что изменилось'      # локально: бамп+sestest+коммит
 *   node scripts/release.mjs --bump minor -m '...' --yes          # и пуш в gitlab + зеркало + тег
 *   node scripts/release.mjs --set 0.3.19 -m '...' --yes
 *   node scripts/release.mjs --bump minor -m '...' --no-mirror    # только gitlab
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
/** Монорепо: сюда коммитится сам плагин (ветка публикуется в gitlab). */
const REPO_DIR = join(PLUGIN_DIR, '..', '..')
/** Клон публикации: standalone-пакет с тегами vX, из него ставится `github:`-зависимость. */
const MIRROR_DIR = process.env.VERME_GATE_MIRROR_DIR || '/tmp/dsh-verme-gate-plugin'
const GITLAB_REMOTE = process.env.VERME_GATE_GITLAB_REMOTE || 'gitlab'
const GITLAB_BRANCH = process.env.VERME_GATE_GITLAB_BRANCH || 'feat/dsh-verme-gate'
const MIRROR_REMOTE = process.env.VERME_GATE_MIRROR_REMOTE || 'origin'

/** Разобрать argv: только те флаги, что описаны в шапке. */
function parseArgs(argv) {
  const options = { bump: '', set: '', message: '', yes: false, mirror: true, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--bump') options.bump = argv[++index] || ''
    else if (arg === '--set') options.set = argv[++index] || ''
    else if (arg === '-m' || arg === '--message') options.message = argv[++index] || ''
    else if (arg === '--yes') options.yes = true
    else if (arg === '--no-mirror') options.mirror = false
    else if (arg === '-h' || arg === '--help') options.help = true
    else throw new Error('неизвестный аргумент: ' + arg)
  }
  return options
}

/** Запустить команду и вернуть stdout; ошибку — с хвостом вывода, а не «exit code 1». */
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = String((error && error.stderr) || '')
    const stdout = String((error && error.stdout) || '')
    throw new Error(command + ' ' + args.join(' ') + ' упал: ' + (stderr || stdout || String(error)))
  }
}

/** Следующая версия по semver-бампу (без библиотек: схема у нас простая). */
function bumped(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (match === null) throw new Error('версия не в виде X.Y.Z: ' + version)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (kind === 'major') return (major + 1) + '.0.0'
  if (kind === 'minor') return major + '.' + (minor + 1) + '.0'
  if (kind === 'patch') return major + '.' + minor + '.' + (patch + 1)
  throw new Error('--bump принимает major|minor|patch')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write('node scripts/release.mjs --bump minor|patch|major|--set X.Y.Z -m "сообщение" [--yes] [--no-mirror]\n')
  process.exit(0)
}
const manifestPath = join(PLUGIN_DIR, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const next = options.set !== '' ? options.set : bumped(manifest.version, options.bump)
const message = options.message.trim()
if (message === '') throw new Error('нужно -m "что изменилось" — сообщение уходит и в коммит, и в тег')
if (next === manifest.version) throw new Error('версия не меняется: ' + next)

process.stdout.write('verme-gate ' + manifest.version + ' → ' + next + '\n')
manifest.version = next
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
run('node', [join(PLUGIN_DIR, 'scripts', 'build-client.mjs')], PLUGIN_DIR)
run('node', [join(PLUGIN_DIR, 'scripts', 'sync-prompts.mjs'), '--check'], PLUGIN_DIR)
const selftest = run('node', [join(PLUGIN_DIR, 'selftest.mjs')], PLUGIN_DIR)
if (!selftest.includes('selftest: PASS')) throw new Error('selftest не прошёл:\n' + selftest.split('\n').slice(-8).join('\n'))
process.stdout.write('selftest: PASS\n')

const commitMessage = 'verme-gate ' + next + ': ' + message
run('git', ['add', '-A', 'plugins/dsh-mcp-access'], REPO_DIR)
run('git', ['commit', '-m', commitMessage], REPO_DIR)
const sha = run('git', ['rev-parse', '--short', 'HEAD'], REPO_DIR)
process.stdout.write('коммит ' + sha + ' в монорепо\n')

if (!options.yes) {
  process.stdout.write('\nбез --yes пуш не делаю. Дальше руками:\n'
    + '  git -C ' + REPO_DIR + ' push ' + GITLAB_REMOTE + ' HEAD:' + GITLAB_BRANCH + '\n')
  if (options.mirror) process.stdout.write('  node scripts/release.mjs --publish-only --set ' + next + ' -m "' + message + '" --yes\n')
  process.exit(0)
}

run('git', ['push', GITLAB_REMOTE, 'HEAD:' + GITLAB_BRANCH], REPO_DIR)
process.stdout.write('пуш в ' + GITLAB_REMOTE + ':' + GITLAB_BRANCH + '\n')

if (options.mirror) {
  if (!existsSync(join(MIRROR_DIR, '.git'))) throw new Error('нет клона публикации: ' + MIRROR_DIR
    + ' (git clone git@github.com:irtokarkkeja/dsh-verme-gate-plugin.git ' + MIRROR_DIR + ')')
  const files = ['index.js', 'cordis.patch.yml', 'package.json', 'README.md', 'page.html', 'selftest.mjs', 'lib', 'client', 'prompts', 'scripts']
  for (const file of files) run('cp', ['-a', join(PLUGIN_DIR, file), join(MIRROR_DIR, file)], MIRROR_DIR)
  run('git', ['add', '-A'], MIRROR_DIR)
  run('git', ['commit', '-m', 'verme-gate ' + next + ': ' + message], MIRROR_DIR)
  const tag = 'v' + next
  run('git', ['tag', '-a', tag, '-m', 'verme-gate ' + next], MIRROR_DIR)
  run('git', ['push', MIRROR_REMOTE, 'HEAD:main', tag], MIRROR_DIR)
  process.stdout.write('зеркало: ' + MIRROR_DIR + ' → ' + MIRROR_REMOTE + ' main + тег ' + tag + '\n')
}

process.stdout.write('\nобновить профиль (пример для лабы):\n'
  + '  dsh plugin --profile web add github:irtokarkkeja/dsh-verme-gate-plugin#v' + next + '\n'
  + '  systemctl --user restart dsh-lab-3091.service\n')