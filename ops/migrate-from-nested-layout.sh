#!/bin/bash
# Copies host-only state from the former ./ai-factory layout into repository
# root. It never deletes the source and refuses to overwrite a destination.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OLD_DIR="$ROOT_DIR/ai-factory"
MODE="${1:---check}"

if [[ "$MODE" != "--check" && "$MODE" != "--apply" ]]; then
  echo "Usage: bash ops/migrate-from-nested-layout.sh [--check|--apply]" >&2
  exit 2
fi

ITEMS=(.env projects.local.yaml routing.local.yaml runs)

if [[ ! -d "$OLD_DIR" ]]; then
  echo "No former nested layout at $OLD_DIR. Nothing to migrate."
  exit 0
fi

FOUND=()
for item in "${ITEMS[@]}"; do
  if [[ -e "$OLD_DIR/$item" ]]; then
    FOUND+=("$item")
  fi
done

if [[ ${#FOUND[@]} -eq 0 ]]; then
  echo "Former layout exists, but it contains no host state to migrate."
  exit 0
fi

echo "Host state found in the former layout: ${FOUND[*]}"

for item in "${FOUND[@]}"; do
  if [[ -e "$ROOT_DIR/$item" ]]; then
    echo "Destination already exists: $ROOT_DIR/$item (refusing to overwrite)." >&2
    exit 1
  fi
done

if [[ "$MODE" == "--check" ]]; then
  echo "Check only. Stop the launchd services, then rerun with --apply."
  exit 0
fi

if command -v launchctl >/dev/null 2>&1; then
  UID_NUM="$(id -u)"
  for service in com.ai-factory.poller com.ai-factory.server; do
    if launchctl print "gui/$UID_NUM/$service" >/dev/null 2>&1; then
      echo "Service $service is loaded. Stop both factory services before copying SQLite state." >&2
      exit 1
    fi
  done
fi

for item in "${FOUND[@]}"; do
  cp -pR "$OLD_DIR/$item" "$ROOT_DIR/$item"
  echo "Copied $item"
done

echo "Migration copy complete. The source remains at $OLD_DIR for rollback."
echo "Run npm run doctor and then install the root-level launchd service."
