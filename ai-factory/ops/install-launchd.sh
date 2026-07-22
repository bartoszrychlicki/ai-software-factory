#!/bin/bash
# Instalacja fabryki jako usług launchd (auto-start przy logowaniu, auto-restart po padzie).
# Użycie: bash ops/install-launchd.sh   (idempotentne — przeładowuje, jeśli już zainstalowane)
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
FACTORY_DIR="$(cd "$OPS_DIR/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
FACTORY_NPM_BIN="/Users/senioraiconsultant/.local/bin/npm"
SERVER_SERVICE="com.ai-factory.server"
POLLER_SERVICE="com.ai-factory.poller"
SERVER_PLIST="$AGENTS_DIR/$SERVER_SERVICE.plist"
POLLER_PLIST="$AGENTS_DIR/$POLLER_SERVICE.plist"

# bootout jest asynchroniczny. Build może ruszyć dopiero wtedy, gdy proces
# naprawdę zniknął i nie czyta już regenerowanego katalogu .mastra/output.
wait_until_unloaded() {
  local service="$1"
  for attempt in {1..30}; do
    if ! launchctl print "gui/$UID_NUM/$service" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$attempt" == "30" ]]; then
      echo "Usługa $service nie zatrzymała się w 30 s." >&2
      return 1
    fi
    sleep 1
  done
}

bootout_agent() {
  local service="$1"
  launchctl bootout "gui/$UID_NUM/$service" 2>/dev/null || true
  wait_until_unloaded "$service"
}

bootstrap_agent() {
  local service="$1"
  local plist="$2"
  local output=""

  # To jest twardy warunek: nie wolno uznać starego, jeszcze gasnącego joba
  # za poprawnie załadowaną nową wersję.
  wait_until_unloaded "$service"
  for attempt in {1..20}; do
    if output="$(launchctl bootstrap "gui/$UID_NUM" "$plist" 2>&1)"; then
      return 0
    fi
    if launchctl print "gui/$UID_NUM/$service" >/dev/null 2>&1; then
      echo "Nieoczekiwany job $service po nieudanym bootstrapie: $output" >&2
      return 1
    fi
    if [[ "$attempt" == "20" ]]; then
      echo "Nie udało się załadować $service: $output" >&2
      return 1
    fi
    sleep 1
  done
}

find_unfinished_runs() {
  '/Users/senioraiconsultant/.local/bin/node' -e '
const fs=require("fs"), p=require("path"), root=p.join(process.argv[1],"runs");
let ids=[];
if(fs.existsSync(root)) for(const ticket of fs.readdirSync(root)) {
  const file=p.join(root,ticket,"state.json");
  try { const s=JSON.parse(fs.readFileSync(file,"utf8")); if(s.lifecycle!=="finalized") ids.push(ticket); } catch {}
}
process.stdout.write(ids.join(","));
' "$FACTORY_DIR"
}

mkdir -p "$HOME/.ai-factory/logs"
mkdir -p "$AGENTS_DIR"

POLLER_WAS_LOADED=false
if launchctl print "gui/$UID_NUM/$POLLER_SERVICE" >/dev/null 2>&1; then
  POLLER_WAS_LOADED=true
fi

# Najpierw zamrażamy dopływ pracy. Dopiero stabilny snapshot rejestru może
# zdecydować, czy wolno przełączyć runtime.
bootout_agent "$POLLER_SERVICE"

# Nie przełączamy runtime'u pod aktywnym workflow. Najpierw trzeba pozwolić
# pollerowi domknąć run albo świadomie go anulować w Linear.
UNFINISHED="$(find_unfinished_runs)"
if [[ -n "$UNFINISHED" ]]; then
  if [[ "$POLLER_WAS_LOADED" == "true" && -f "$POLLER_PLIST" ]]; then
    bootstrap_agent "$POLLER_SERVICE" "$POLLER_PLIST"
  fi
  echo "Aktywne runy: $UNFINISHED — instalacja przerwana, poller przywrócony." >&2
  exit 1
fi

bootout_agent "$SERVER_SERVICE"

# Jeżeli 4111 nadal odpowiada, port zajmuje proces spoza zarządzanej usługi.
# Nie budujemy wtedy współdzielonego bundle'a pod żywym procesem.
if /usr/bin/curl --silent --max-time 2 http://localhost:4111/ >/dev/null 2>&1; then
  echo "Port 4111 nadal jest zajęty po zatrzymaniu $SERVER_SERVICE." >&2
  echo "Zatrzymaj ręcznie uruchomione mastra dev/start i ponów instalację." >&2
  exit 1
fi

# Produkcja uruchamia nieruchomy bundle, bez hot reloadu. Mastra regeneruje
# .mastra/output destrukcyjnie, dlatego build odbywa się po pełnym bootout.
cd "$FACTORY_DIR"
"$FACTORY_NPM_BIN" run build

for artifact in index.mjs mastra.mjs tools.mjs studio/index.html; do
  if [[ ! -f "$FACTORY_DIR/.mastra/output/$artifact" ]]; then
    echo "Niekompletny bundle Mastry: brak .mastra/output/$artifact" >&2
    exit 1
  fi
done

cp "$OPS_DIR/com.ai-factory.server.plist" "$SERVER_PLIST"
bootstrap_agent "$SERVER_SERVICE" "$SERVER_PLIST"
echo "✓ $SERVER_SERVICE załadowany"

# Poller nie może claimować ticketów, dopóki API i Studio z nowego bundle'a
# nie odpowiedzą. Sprawdzamy oba endpointy, bo awaria dotyczyła tylko Studio.
for attempt in {1..30}; do
  STUDIO_HTML="$(/usr/bin/curl --fail --silent --max-time 2 http://localhost:4111/ 2>/dev/null || true)"
  if /usr/bin/curl --fail --silent --max-time 2 http://localhost:4111/api/workflows >/dev/null \
    && [[ "$STUDIO_HTML" == *'<title>Mastra Studio</title>'* ]]; then
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    echo "API lub Studio Mastry nie wystartowało — poller pozostaje wyłączony." >&2
    exit 1
  fi
  sleep 1
done

cp "$OPS_DIR/com.ai-factory.poller.plist" "$POLLER_PLIST"
bootstrap_agent "$POLLER_SERVICE" "$POLLER_PLIST"
echo "✓ $POLLER_SERVICE załadowany"

echo
echo "Status:"
launchctl list | grep ai-factory || true
echo
echo "Logi: ~/.ai-factory/logs/{server,poller}{,.err}.log"
echo "Stop:  launchctl bootout gui/$UID_NUM/com.ai-factory.<server|poller>"
