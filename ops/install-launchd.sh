#!/bin/bash
# Instalacja fabryki jako usług launchd (auto-start przy logowaniu, auto-restart po padzie).
# Użycie: bash ops/install-launchd.sh                    (idempotentne — przeładowuje, jeśli już zainstalowane)
#         bash ops/install-launchd.sh --render-only DIR  (tylko wyrenderuj plisty do DIR — podgląd bez instalacji)
#
# Plisty powstają z szablonów ops/*.plist.template: npm/node/claude, katalog
# fabryki i $HOME są wykrywane na hoście (command -v), nie hardcodowane —
# te same pliki działają na każdej maszynie. Analogicznie yaml-e konfiguracyjne
# nadpisuje się per host przez projects.local.yaml / routing.local.yaml (README).
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
FACTORY_DIR="$(cd "$OPS_DIR/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
SERVER_SERVICE="com.ai-factory.server"
POLLER_SERVICE="com.ai-factory.poller"
SERVER_PLIST="$AGENTS_DIR/$SERVER_SERVICE.plist"
POLLER_PLIST="$AGENTS_DIR/$POLLER_SERVICE.plist"
SERVER_TEMPLATE="$OPS_DIR/$SERVER_SERVICE.plist.template"
POLLER_TEMPLATE="$OPS_DIR/$POLLER_SERVICE.plist.template"

RENDER_ONLY_DIR=""
case "${1:-}" in
  "") ;;
  --render-only)
    RENDER_ONLY_DIR="${2:-}"
    if [[ -z "$RENDER_ONLY_DIR" ]]; then
      echo "--render-only wymaga katalogu docelowego." >&2
      exit 2
    fi
    ;;
  *)
    echo "Nieznany argument: $1 (dozwolone: --render-only DIR)" >&2
    exit 2
    ;;
esac

preflight_terminal_notifier() {
  if ! command -v terminal-notifier >/dev/null 2>&1; then
    echo "terminal-notifier nie jest zainstalowany. Zainstaluj: brew install terminal-notifier" >&2
    exit 1
  fi
}

# --- wykrywanie toolchainu hosta (zamiast hardcodowanych /opt/homebrew/bin/*) ---

detect_bin() {
  local name="$1" found=""
  if ! found="$(command -v "$name" 2>/dev/null)"; then
    echo "Nie znaleziono \"$name\" w PATH — instalacja przerwana (fail-closed)." >&2
    return 1
  fi
  printf '%s\n' "$found"
}

# Wartości wchodzą do sed z separatorem "|"; znak specjalny = twardy błąd
# zamiast cicho uszkodzonego plista.
assert_sed_safe() {
  local name="$1" value="$2"
  case "$value" in
    *"|"* | *"&"* | *$'\n'* | *"@@"*)
      echo "Wartość $name zawiera niedozwolony znak (| & @@ albo nową linię): $value" >&2
      return 1
      ;;
  esac
}

prepend_service_path_dir() {
  local dir="$1"
  case ":$SERVICE_PATH:" in
    *":$dir:"*) ;;
    *) SERVICE_PATH="$dir:$SERVICE_PATH" ;;
  esac
}

detect_toolchain() {
  FACTORY_NPM_BIN="$(detect_bin npm)"
  FACTORY_NODE_BIN="$(detect_bin node)"
  # claude przez pełną ścieżkę (funkcja shellowa przechwytuje gołą komendę);
  # najpierw standardowa lokalizacja instalatora, dopiero potem PATH.
  if [[ -x "$HOME/.local/bin/claude" ]]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  else
    CLAUDE_BIN="$(detect_bin claude)"
  fi
  # PATH usług launchd (minimalny systemowy nie zawiera CLI agentów — BAR-92):
  # katalogi per host wyprowadzone z $HOME + wykryte lokalizacje node/npm.
  SERVICE_PATH="$HOME/.local/bin:$HOME/.kimi-code/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  prepend_service_path_dir "$(dirname "$FACTORY_NODE_BIN")"
  prepend_service_path_dir "$(dirname "$FACTORY_NPM_BIN")"

  assert_sed_safe HOME "$HOME"
  assert_sed_safe FACTORY_DIR "$FACTORY_DIR"
  assert_sed_safe FACTORY_NPM_BIN "$FACTORY_NPM_BIN"
  assert_sed_safe CLAUDE_BIN "$CLAUDE_BIN"
  assert_sed_safe SERVICE_PATH "$SERVICE_PATH"
}

render_plist() {
  local template="$1" target="$2"
  if [[ ! -f "$template" ]]; then
    echo "Brak szablonu $template." >&2
    return 1
  fi
  sed \
    -e "s|@@NPM_BIN@@|$FACTORY_NPM_BIN|g" \
    -e "s|@@CLAUDE_BIN@@|$CLAUDE_BIN|g" \
    -e "s|@@FACTORY_DIR@@|$FACTORY_DIR|g" \
    -e "s|@@SERVICE_PATH@@|$SERVICE_PATH|g" \
    -e "s|@@HOME@@|$HOME|g" \
    "$template" > "$target"
  if grep -q "@@" "$target"; then
    echo "Po renderze $target zostały niepodstawione placeholdery:" >&2
    grep -n "@@" "$target" >&2
    return 1
  fi
  # plutil jest zawsze na macOS (tylko tam działa launchd); na CI Linux pomijamy lint.
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$target" >/dev/null
  fi
}

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

find_blocking_runs() {
  "$FACTORY_NODE_BIN" -e '
const fs=require("fs"), p=require("path"), root=p.join(process.argv[1],"runs");
const ids=new Set(), imported=new Set();
const dbFile=p.join(root,"lifecycle.db");
if(fs.existsSync(dbFile)) {
  const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync(dbFile,{readOnly:true});
  for(const row of db.prepare("SELECT ticket_id, status FROM lifecycle_runs").all()) {
    imported.add(row.ticket_id);
    if(row.status==="running") ids.add(row.ticket_id);
  }
  db.close();
}
if(fs.existsSync(root)) for(const ticket of fs.readdirSync(root)) {
  if(imported.has(ticket)) continue;
  const file=p.join(root,ticket,"state.json");
  try {
    const s=JSON.parse(fs.readFileSync(file,"utf8"));
    if(s.lifecycle!=="finalized" && s.lifecycle!=="awaiting_decision") ids.add(ticket);
  } catch {}
}
process.stdout.write([...ids].join(","));
' "$FACTORY_DIR"
}

find_suspended_runs() {
  "$FACTORY_NODE_BIN" -e '
const fs=require("fs"), p=require("path"), root=p.join(process.argv[1],"runs");
const ids=new Set(), imported=new Set();
const dbFile=p.join(root,"lifecycle.db");
if(fs.existsSync(dbFile)) {
  const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync(dbFile,{readOnly:true});
  for(const row of db.prepare("SELECT ticket_id, status FROM lifecycle_runs").all()) {
    imported.add(row.ticket_id);
    if(row.status==="waiting_human" || row.status==="waiting_external") ids.add(row.ticket_id);
  }
  db.close();
}
if(fs.existsSync(root)) for(const ticket of fs.readdirSync(root)) {
  if(imported.has(ticket)) continue;
  const file=p.join(root,ticket,"state.json");
  try { const s=JSON.parse(fs.readFileSync(file,"utf8")); if(s.lifecycle==="awaiting_decision") ids.add(ticket); } catch {}
}
process.stdout.write([...ids].join(","));
' "$FACTORY_DIR"
}

# Podgląd plistów bez dotykania launchd/builda — np. weryfikacja nowego hosta.
if [[ -n "$RENDER_ONLY_DIR" ]]; then
  detect_toolchain
  mkdir -p "$RENDER_ONLY_DIR"
  render_plist "$SERVER_TEMPLATE" "$RENDER_ONLY_DIR/$SERVER_SERVICE.plist"
  render_plist "$POLLER_TEMPLATE" "$RENDER_ONLY_DIR/$POLLER_SERVICE.plist"
  echo "Wyrenderowano plisty do $RENDER_ONLY_DIR (npm: $FACTORY_NPM_BIN, node: $FACTORY_NODE_BIN, claude: $CLAUDE_BIN)."
  exit 0
fi

preflight_terminal_notifier

detect_toolchain

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
BLOCKING="$(find_blocking_runs)"
if [[ -n "$BLOCKING" ]]; then
  if [[ "$POLLER_WAS_LOADED" == "true" && -f "$POLLER_PLIST" ]]; then
    bootstrap_agent "$POLLER_SERVICE" "$POLLER_PLIST"
  fi
  echo "Aktywne runy wykonawcze: $BLOCKING — instalacja przerwana, poller przywrócony." >&2
  exit 1
fi

# Suspend na human gate jest trwały w Mastra + rejestrze. Można bezpiecznie
# przełączyć runtime; po bootstrapie poller zaadoptuje run i zachowa bramkę.
SUSPENDED="$(find_suspended_runs)"
if [[ -n "$SUSPENDED" ]]; then
  echo "Trwałe runy awaiting_decision: $SUSPENDED — przełączam runtime; poller zaadoptuje je po restarcie."
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

render_plist "$SERVER_TEMPLATE" "$SERVER_PLIST"
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

render_plist "$POLLER_TEMPLATE" "$POLLER_PLIST"
bootstrap_agent "$POLLER_SERVICE" "$POLLER_PLIST"
echo "✓ $POLLER_SERVICE załadowany"

echo
echo "Status:"
launchctl list | grep ai-factory || true
echo
echo "Logi: ~/.ai-factory/logs/{server,poller}{,.err}.log"
echo "Stop:  launchctl bootout gui/$UID_NUM/com.ai-factory.<server|poller>"
