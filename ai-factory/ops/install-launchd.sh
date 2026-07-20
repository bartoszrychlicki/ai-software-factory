#!/bin/bash
# Instalacja fabryki jako usług launchd (auto-start przy logowaniu, auto-restart po padzie).
# Użycie: bash ops/install-launchd.sh   (idempotentne — przeładowuje, jeśli już zainstalowane)
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

mkdir -p "$HOME/.ai-factory/logs"

for svc in com.ai-factory.server com.ai-factory.poller; do
  cp "$OPS_DIR/$svc.plist" "$AGENTS_DIR/$svc.plist"
  launchctl bootout "gui/$UID_NUM/$svc" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS_DIR/$svc.plist"
  echo "✓ $svc załadowany"
done

echo
echo "Status:"
launchctl list | grep ai-factory || true
echo
echo "Logi: ~/.ai-factory/logs/{server,poller}{,.err}.log"
echo "Stop:  launchctl bootout gui/$UID_NUM/com.ai-factory.<server|poller>"
