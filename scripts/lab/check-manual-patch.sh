#!/usr/bin/env bash
# Ручной (аварийный) режим установки: плагин уже в node_modules, но НЕ в dsh.profile.bundles —
# строка в cordis.patch.yml профиля абсолютным путём. Проверяем, что так тоже поднимается.
set -uo pipefail
HOME_DIR=/home/seva/.dsh-dist-test-tgz
PROFILE="$HOME_DIR/profiles/web"
NODE=/snap/node/current/bin/node
PKG="$PROFILE/node_modules/verme-gate"

[ -d "$PKG" ] || { echo "нет пакета $PKG"; exit 1; }

echo '=== 1) убрать verme-gate из bundles (ручной режим не должен дублировать бандл) ==='
cp "$PROFILE/package.json" /tmp/manual-pkg.bak.json
$NODE -e '
const fs=require("node:fs");
const path=process.argv[1];
const pkg=JSON.parse(fs.readFileSync(path,"utf8"));
const bundles=(pkg.dsh&&pkg.dsh.profile&&pkg.dsh.profile.bundles)||[];
pkg.dsh=pkg.dsh||{}; pkg.dsh.profile=pkg.dsh.profile||{};
pkg.dsh.profile.bundles=bundles.filter((b)=>b!=="verme-gate");
fs.writeFileSync(path, JSON.stringify(pkg,null,2)+"\n");
console.log("bundles:", pkg.dsh.profile.bundles.join(", "));
' "$PROFILE/package.json"

echo '=== 2) записать строку в cordis.patch.yml профиля ==='
test -f "$PROFILE/cordis.patch.yml" && cp "$PROFILE/cordis.patch.yml" /tmp/manual-patch.bak.yml
cat > "$PROFILE/cordis.patch.yml" <<YAML
- insert:
    - id: verme-gate
      name: $PKG/index.js
- id: agent-default-model
  config:
    provider: dshlab
    model: deepseek/deepseek-v4-pro
    reasoningEffort: low
YAML
cat "$PROFILE/cordis.patch.yml"
echo '=== 3) поднять инстанс и проверить маршруты ==='
bash /home/seva/verme/agents/plugins/dsh-mcp-access/scripts/lab/check-dist-home.sh "$HOME_DIR" 3098 /tmp/dist-manual.log 2>&1 | tail -8
