import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "../../ops/install-launchd.sh"), "utf8");

function position(fragment: string): number {
  const index = script.indexOf(fragment);
  assert.notEqual(index, -1, `brak oczekiwanego fragmentu: ${fragment}`);
  return index;
}

function lastPosition(fragment: string): number {
  const index = script.lastIndexOf(fragment);
  assert.notEqual(index, -1, `brak oczekiwanego fragmentu: ${fragment}`);
  return index;
}

test("instalator nie regeneruje bundle'a pod działającym serwerem", () => {
  const freezePoller = position('bootout_agent "$POLLER_SERVICE"');
  const snapshotRuns = position('UNFINISHED="$(find_unfinished_runs)"');
  const stopServer = position('bootout_agent "$SERVER_SERVICE"');
  const build = position('"$FACTORY_NPM_BIN" run build');
  const validateBundle = position('for artifact in index.mjs mastra.mjs tools.mjs studio/index.html');
  const startServer = position('bootstrap_agent "$SERVER_SERVICE" "$SERVER_PLIST"');
  const healthStudio = position("<title>Mastra Studio</title>");
  const startPoller = lastPosition('bootstrap_agent "$POLLER_SERVICE" "$POLLER_PLIST"');

  assert.ok(freezePoller < snapshotRuns);
  assert.ok(snapshotRuns < stopServer);
  assert.ok(stopServer < build);
  assert.ok(build < validateBundle);
  assert.ok(validateBundle < startServer);
  assert.ok(startServer < healthStudio);
  assert.ok(healthStudio < startPoller);
});

test("nieudany bootstrap nie akceptuje starego joba jako sukcesu", () => {
  assert.doesNotMatch(
    script,
    /if launchctl print[^}]+then\s+return 0/s,
    "stary job launchd nie może maskować nieudanego bootstrapu",
  );
});
