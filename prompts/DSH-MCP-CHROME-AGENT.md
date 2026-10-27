# ИНСТРУКЦИЯ АГЕНТУ: браузерный MCP (chrome-devtools) в DSH — всегда видимый Chrome

Ты — агент, которому человек отдал этот файл. Выполни шаги сам, в конце прогони приёмку и
покажи результат. Всё, что в угловых скобках `<…>` — подставляет человек; ничего не выдумывай.

**Главное отличие от обычной настройки:** здесь агент работает **только в видимом браузере** —
он подключается к настоящему окну Chrome/Edge на этой же машине, и человек видит каждое действие
(новые вкладки открываются прямо у него на экране). Headless-режим в этом варианте исключён
по построению: лаунчер не умеет запускать скрытый браузер, он только поднимает видимое окно с
отладочным портом и подключается к нему.

## 0. Что получится

- 29 браузерных тулов у DSH: навигация и вкладки, снимок страницы для модели (a11y-дерево),
  скриншоты, клики/ввод, JS, консоль, сеть (включая заголовки `Cookie`), эмуляция, performance-
  трассы, Lighthouse, heap-снапшот, диалоги, загрузка файлов.
- Работает в **отдельном профиле** (`--user-data-dir`), который лаунчер поднимает автоматически:
  личный профиль коллеги не трогается, а окно видно на экране.
- Закрыл окно — агент без браузера; лечится перезапуском DSH (см. шаг 7).

## 1. Предпосылки

- **Node.js ≥ 20** (`node --version`, нужен и `npx`).
- **Chrome или Edge** (любой Chromium) на машине. Если нет — puppeteer скачает Chrome for Testing
  сам (~150 МБ) при первом запуске; Edge подходит и часто уже есть на корп-ПК.
- **Отдельный `--user-data-dir` обязателен.** Chrome с версии 136 игнорирует
  `--remote-debugging-port`, если запущен на профиле по умолчанию. Поэтому лаунчер всегда стартует
  Chrome со своим каталогом профиля — это же спасает от конфликта с уже открытым личным Chrome.
- **Сеть/прокси.** Первый `npx` качает пакет (и Chrome). Если в корп-сети рвётся с `ECONNRESET` —
  сначала пропусти установку через разовый прокси, потом прокси сними.

## 2. Установка пакета

Проверка (заодно скачает Chrome):

```
npx -y chrome-devtools-mcp@1.9.0 --version
```

Вариант «закрепить локально» (быстрее старт, версия не поедет):

```
:: Windows
npm i -C "%USERPROFILE%\opt\chrome-devtools-mcp" chrome-devtools-mcp@1.9.0
# Linux
npm i -C ~/opt/chrome-devtools-mcp chrome-devtools-mcp@1.9.0
```

Дальше в примерах используется `npx -y chrome-devtools-mcp@1.9.0`; если поставил локально —
замени на `node "%USERPROFILE%\opt\chrome-devtools-mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js"`.

Обновление: `npm i -C <тот же каталог> chrome-devtools-mcp@latest` + перезапуск DSH.

## 3. Лаунчер для Windows (основной вариант)

Файл `%USERPROFILE%\.dsh\bin\dsh-chrome-devtools-mcp.ps1`:

```powershell
# Браузерный MCP для DSH: ВСЕГДА видимый Chrome/Edge на этой машине.
# Поднимает окно с отладочным портом (отдельный профиль), ждёт CDP и подключается к нему.
# Headless-пути здесь нет намеренно. Весь служебный вывод - только в лог (stdout = протокол MCP).
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:USERPROFILE '.cache\chrome-devtools-mcp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'server.log'
$chromeLog = Join-Path $logDir 'chrome.log'

$port = if ($env:CHROME_MCP_PORT) { $env:CHROME_MCP_PORT } else { '9222' }
$profileDir = if ($env:CHROME_MCP_PROFILE) { $env:CHROME_MCP_PROFILE } else { Join-Path $env:USERPROFILE '.cache\chrome-agent-profile' }
$cdp = "http://127.0.0.1:$port"
$extra = if ($env:CHROME_MCP_EXTRA_ARGS) { $env:CHROME_MCP_EXTRA_ARGS.Split(' ') } else { @() }

function Test-Cdp {
  try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$cdp/json/version").StatusCode -eq 200 }
  catch { $false }
}

if (-not (Test-Cdp)) {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft\Edge\Application\msedge.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }
  $chrome = $candidates | Select-Object -First 1
  if (-not $chrome) {
    $chrome = (Get-ChildItem "$env:USERPROFILE\.cache\puppeteer\chrome\*\chrome-win64\chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
  }
  if (-not $chrome) {   # управляемый кэш браузера самого DSH
    $chrome = (Get-ChildItem "$env:USERPROFILE\.agent-browser\browsers\*\chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
  }
  if (-not $chrome) { "launcher: Chromium не найден" | Out-File -Append $log; exit 1 }

  "launcher: $(Get-Date -Format s) start visible $chrome (port $port)" | Out-File -Append $log
  Start-Process -FilePath $chrome -ArgumentList (@(
    "--remote-debugging-port=$port",
    "--user-data-dir=$profileDir",
    '--no-first-run', '--no-default-browser-check'
  ) + $extra) -RedirectStandardError $chromeLog -RedirectStandardOutput $chromeLog | Out-Null

  $ok = $false
  for ($i = 0; $i -lt 40; $i++) { if (Test-Cdp) { $ok = $true; break }; Start-Sleep -Milliseconds 500 }
  if (-not $ok) { "launcher: CDP не поднялся на $cdp (см. chrome.log)" | Out-File -Append $log; exit 1 }
}
"launcher: $(Get-Date -Format s) attach $cdp" | Out-File -Append $log

$env:CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = 'true'
$env:CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = 'true'
$local = Join-Path $env:USERPROFILE 'opt\chrome-devtools-mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js'
if (Test-Path $local) {          # локальная установка (шаг 2) приоритетнее npx
  & node $local --browser-url $cdp --no-usage-statistics --no-performance-crux 2>> $log
} else {
  & npx -y chrome-devtools-mcp@1.9.0 --browser-url $cdp --no-usage-statistics --no-performance-crux 2>> $log
}
```

Проверить руками (должно открыться окно Chrome и в логе появиться `attach`):

```
powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.dsh\bin\dsh-chrome-devtools-mcp.ps1"
```
(Эта ручная проверка запустит сервер в консоли — закрой её через Ctrl+C, окно Chrome останется.)

## 4. Лаунчер для Linux (тот же принцип, если у коллеги Linux)

Файл `~/.dsh/bin/dsh-chrome-devtools-mcp.sh`:

```bash
#!/usr/bin/env bash
# То же самое на Linux: только видимый Chrome (нужна графическая сессия).
set -uo pipefail
export CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=true
export CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=true
LOGDIR="$HOME/.cache/chrome-devtools-mcp"; mkdir -p "$LOGDIR"
PORT="${CHROME_MCP_PORT:-9222}"; CDP="http://127.0.0.1:$PORT"
PROFILE="${CHROME_MCP_PROFILE:-$HOME/.cache/chrome-agent-profile}"

up() { curl -sf --max-time 2 "$CDP/json/version" >/dev/null 2>&1; }

if ! up; then
  CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)"
  # Chrome for Testing из кэша puppeteer, затем управляемый кэш DSH (~/.agent-browser)
  [ -z "$CHROME" ] && CHROME="$(ls -1d "$HOME"/.cache/puppeteer/chrome/*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1)"
  [ -z "$CHROME" ] && CHROME="$(ls -1d "$HOME"/.agent-browser/browsers/*/chrome 2>/dev/null | sort -V | tail -1)"
  [ -z "$CHROME" ] && { echo "launcher: Chromium не найден" >>"$LOGDIR/server.log"; exit 1; }
  # видимому Chrome нужна графическая сессия; без DISPLAY окна не будет
  [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || echo "launcher: ВНИМАНИЕ нет DISPLAY/WAYLAND_DISPLAY — видимое окно не поднимется" >>"$LOGDIR/server.log"
  echo "launcher: $(date -Is) start visible $CHROME (port $PORT)" >>"$LOGDIR/server.log"
  nohup "$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
        --no-first-run --no-default-browser-check --no-sandbox --disable-dev-shm-usage \
        ${CHROME_MCP_EXTRA_ARGS:-} >/dev/null 2>>"$LOGDIR/chrome.log" &
  for _ in $(seq 1 40); do up && break; sleep 0.5; done
  up || { echo "launcher: CDP не поднялся на $CDP" >>"$LOGDIR/server.log"; exit 1; }
fi
echo "launcher: $(date -Is) attach $CDP" >>"$LOGDIR/server.log"

# локальная установка (шаг 2) приоритетнее npx: быстрее старт, версия закреплена
SERVER_JS="$HOME/opt/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
if [ -f "$SERVER_JS" ]; then
  exec node "$SERVER_JS" --browser-url "$CDP" --no-usage-statistics --no-performance-crux 2>>"$LOGDIR/server.log"
fi
exec npx -y chrome-devtools-mcp@1.9.0 --browser-url "$CDP" --no-usage-statistics --no-performance-crux \
     2>>"$LOGDIR/server.log"
```

`--no-sandbox` нужен на Ubuntu 24.04+/26.04: AppArmor запрещает непривилегированные user
namespaces, а у Chrome for Testing нет AppArmor-профиля. На Windows флаг не нужен.

```
chmod +x ~/.dsh/bin/dsh-chrome-devtools-mcp.sh
```

## 5. Патч-слой DSH (`$DSH_HOME/cordis.patch.yml`)

Бэкап, затем блок в конец файла (Windows-вариант; отступы — пробелы):

```yaml
# Chrome DevTools MCP: агент работает ТОЛЬКО в видимом браузере (окно на экране у человека)
- insert:
    - id: mcp-chrome-devtools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome-devtools
        transport: stdio
        command: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
        args:
          - '-NoProfile'
          - '-ExecutionPolicy'
          - 'Bypass'
          - '-File'
          - 'C:\Users\<user>\.dsh\bin\dsh-chrome-devtools-mcp.ps1'
        env:
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true'
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: 'true'
        toolCallTimeoutMs: 180000
        reconnect:
          enabled: true
          initialDelayMs: 2000
          maxDelayMs: 30000
          maxAttempts: 90
```

Почему так:
- `-NoProfile` обязателен: вывод профиля PowerShell попал бы в stdout и сломал stdio-протокол MCP.
- `toolCallTimeoutMs: 180000` — трассы, Lighthouse и скриншоты живут дольше обычного вызова.
- `maxAttempts: 90` — Chrome при старте DSH поднимается позже MCP-клиента; без большого числа
  попыток сервер «сдаётся» и тулы не появляются.
- `env` гасит телеметрию и проверку обновлений (в корп-сети наружу ходить нельзя).

Для Linux: `command: /home/<user>/.dsh/bin/dsh-chrome-devtools-mcp.sh`, `args: []`.

Проверь YAML и перезапусти DSH:

```
python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1],encoding='utf-8'))" ~/.dsh/cordis.patch.yml
dsh web
```

## 6. Приёмка (прогнать и показать результат)

1. `/mcp` в чате DSH → строка `chrome-devtools` connected, **29** тулов.
2. **Человек должен видеть окно**: попроси агента открыть страницу —
   `mcp__chrome-devtools__new_page` `{url: "https://example.com"}` → новая вкладка появляется
   прямо в открытом окне Chrome. Это и есть главный критерий «видимого» режима.
3. Дальше по одному:
   - `mcp__chrome-devtools__list_pages` → JSON со вкладками;
   - `mcp__chrome-devtools__take_snapshot` → a11y-дерево страницы (дешевле скриншота);
   - `mcp__chrome-devtools__take_screenshot` → картинка приходит вложением (и окно видно);
   - `mcp__chrome-devtools__list_console_messages`, `mcp__chrome-devtools__list_network_requests`;
   - `mcp__chrome-devtools__performance_start_trace` → `performance_stop_trace`.
4. Лог лаунчера (там видно режим и порт):
   `%USERPROFILE%\.cache\chrome-devtools-mcp\server.log` (Linux: `~/.cache/chrome-devtools-mcp/server.log`),
   запуск самого Chrome — `chrome.log` в том же каталоге.

## 7. Управление и диагностика

- **Сменить порт** (если 9222 занят): переменная `CHROME_MCP_PORT=9223` в `env` блока патча.
- **Сменить профиль**: `CHROME_MCP_PROFILE`. Разные агенты/окна = разные порт+профиль, иначе они
  дерутся за одну вкладку.
- **Задали логин в этом окне** — он живёт в профиле, пока тот не удалён (в отличие от
  headless-isolated варианта).
- **Закрыл окно Chrome** → тулы падают. Лечение: перезапустить DSH (`dsh web`) либо убить процесс
  `chrome-devtools-mcp` и `node` рядом — клиент переподключит сервер, а лаунчер поднимет окно заново.
- **Проверить, что порт живой вручную**: `curl http://127.0.0.1:9222/json/version`
  (PowerShell: `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version`).
- **Отключить MCP совсем** — закомментировать блок в `cordis.patch.yml` и перезапустить DSH.

## 8. Что доступно (29 тулов)

- **Вкладки/навигация:** `list_pages`, `new_page`, `navigate_page`, `select_page`, `close_page`, `wait_for`.
- **Наблюдение:** `take_snapshot`, `take_screenshot`, `evaluate_script`, `take_heapsnapshot`.
- **Действия:** `click`, `hover`, `fill`, `fill_form`, `type_text`, `press_key`, `drag`, `upload_file`, `handle_dialog`.
- **Консоль:** `list_console_messages`, `get_console_message`.
- **Сеть:** `list_network_requests`, `get_network_request`.
- **Эмуляция:** `emulate`, `resize_page`.
- **Performance:** `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`, `lighthouse_audit`.

## 9. Грабли

- **Окно не появилось, в логе `CDP не поднялся`** → Chrome уже запущен на том же профиле без флага
  (тогда второй запуск просто открывает вкладку в старом окне) или порт занят. Проверь `chrome.log`,
  смени `CHROME_MCP_PORT`, добавь `CHROME_MCP_PROFILE` с новым путём.
- **Chrome 136+ и «порт не слушается»** → запускай только со своим `--user-data-dir`
  (лаунчер так и делает); на профиле по умолчанию отладка отключена намеренно.
- **Тулы не появились, сервер красный в `/mcp`** → почти всегда в stdout что-то печатает обёртка
  (профиль PowerShell, эхо, `Write-Host`): весь вывод — только в лог.
- **`npx` качает пакет каждый старт и тормозит** → поставь пакет локально (шаг 2): лаунчер сам
  предпочтёт `node …chrome-devtools-mcp.js`, если каталог на месте.
- **«Chromium не найден», хотя браузер есть** → ищи не только системный Chrome, но и кэши:
  `~/.cache/puppeteer/chrome/<ver>/chrome-linux64/chrome`, `%USERPROFILE%\.cache\puppeteer\chrome\<ver>\chrome-win64\chrome.exe`
  и управляемый кэш DSH `~/.agent-browser/browsers/<ver>/chrome` (у нас каталог `~/.cache/puppeteer/chrome`
  пустой, а браузер лежит именно в `.agent-browser`). Лаунчер перебирает их по порядку.
- **Баннер «Update available» в логе** → это stderr, протокол не ломает; гасится
  `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=true`, который лаунчер ставит сам.
- **Коллега закрывает окно «чтобы не мешало»** → тогда видимый режим не работает по определению:
  либо окно держим открытым, либо соглашаемся на отдельный видимый профиль на втором мониторе.
- **Linux: «CDP не поднялся», в `chrome.log` пусто** → у процесса нет графической сессии
  (`DISPLAY`/`WAYLAND_DISPLAY` пусты, например DSH запущен из systemd-юнита или по SSH без `-X`):
  видимое окно физически некуда вывести. Лаунчер пишет об этом ВНИМАНИЕ в `server.log`.
- **Логин/капча** → человек может вмешаться прямо в этом окне, агент продолжит с той же страницы —
  это плюс видимого режима.
- **Обновление** → `npm i -C <каталог> chrome-devtools-mcp@latest` + перезапуск DSH.

## 10. Границы и безопасность

- Агент видит всё, что видит браузер: работай в **отдельном профиле** и не логинь туда личные
  сервисы без нужды.
- Видимый режим — это и есть страховка: не оставляй агента одного в админках, прод-панелях и
  платёжках; при странном поведении просто закрой окно.
- `take_screenshot` и снятые страницы уходят модели (могут содержать персональные данные),
  `get_network_request` показывает заголовки `Cookie` — такие ответы не выкладывай в общие чаты.
- 29 тулов занимают место в системном промпте: если агенту браузер не нужен постоянно — держи
  отдельный профиль DSH или отключай сервер.
