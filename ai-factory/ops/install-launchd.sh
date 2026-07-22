#!/bin/bash
# Instalacja fabryki jako usług launchd (auto-start przy logowaniu, auto-restart po padzie).
# Użycie: bash ops/install-launchd.sh   (idempotentne — przeładowuje, jeśli już zainstalowane)
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
FACTORY_DIR="$(cd "$OPS_DIR/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
FACTORY_NPM_BIN="/Users/senioraiconsultant/.local/bin/npm"

# Nie przełączamy runtime'u pod aktywnym workflow. Najpierw trzeba pozwolić
# pollerowi domknąć run albo świadomie go anulować w Linear.
UNFINISHED="$('/Users/senioraiconsultant/.local/bin/node' -e '
const fs=require("fs"), p=require("path"), root=p.join(process.argv[1],"runs");
let ids=[];
if(fs.existsSync(root)) for(const ticket of fs.readdirSync(root)) {
  const file=p.join(root,ticket,"state.json");
  try { const s=JSON.parse(fs.readFileSync(file,"utf8")); if(s.lifecycle!=="finalized") ids.push(ticket); } catch {}
}
process.stdout.write(ids.join(","));
' "$FACTORY_DIR")"
if [[ -n "$UNFINISHED" ]]; then
  echo "Aktywne runy: $UNFINISHED — instalacja przerwana." >&2
  exit 1
fi

mkdir -p "$HOME/.ai-factory/logs"

# Build przed podmianą usług. Produkcja uruchamia nieruchomy bundle, bez hot reloadu.
cd "$FACTORY_DIR"
"$FACTORY_NPM_BIN" run build

for svc in com.ai-factory.server com.ai-factory.poller; do
  launchctl bootout "gui/$UID_NUM/$svc" 2>/dev/null || true
done

cp "$OPS_DIR/com.ai-factory.server.plist" "$AGENTS_DIR/com.ai-factory.server.plist"
launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/com.ai-factory.server.plist"
echo "✓ com.ai-factory.server załadowany"

# Poller nie może claimować ticketów, dopóki API nowego bundle'a nie odpowiada.
for attempt in {1..30}; do
  if /usr/bin/curl --fail --silent --max-time 2 http://localhost:4111/api/workflows >/dev/null; then
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    echo "API Mastry nie wystartowało — poller pozostaje wyłączony." >&2
    exit 1
  fi
  sleep 1
done

cp "$OPS_DIR/com.ai-factory.poller.plist" "$AGENTS_DIR/com.ai-factory.poller.plist"
launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/com.ai-factory.poller.plist"
echo "✓ com.ai-factory.poller załadowany"

echo
echo "Status:"
launchctl list | grep ai-factory || true
echo
echo "Logi: ~/.ai-factory/logs/{server,poller}{,.err}.log"
echo "Stop:  launchctl bootout gui/$UID_NUM/com.ai-factory.<server|poller>"
