import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "../../ops/install-launchd.sh");
const script = readFileSync(scriptPath, "utf8");

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

test("brak terminal-notifier blokuje instalację przed pierwszym bootout", () => {
  const preflight = lastPosition("\npreflight_terminal_notifier\n");
  const freezePoller = position('bootout_agent "$POLLER_SERVICE"');
  assert.ok(preflight < freezePoller);

  const root = mkdtempSync(join(tmpdir(), "factory-launchd-preflight-"));
  const fakeBin = join(root, "bin");
  const launchctlLog = join(root, "launchctl.log");
  const launchctl = join(fakeBin, "launchctl");
  try {
    mkdirSync(fakeBin);
    writeFileSync(launchctl, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"\n');
    chmodSync(launchctl, 0o755);

    const result = spawnSync("/bin/bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        LAUNCHCTL_LOG: launchctlLog,
      },
    });

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /brew install terminal-notifier/);
    assert.equal(existsSync(launchctlLog), false, "launchctl nie może zostać wywołany przed preflightem");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
