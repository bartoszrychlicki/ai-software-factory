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
  const snapshotRuns = position('BLOCKING="$(find_blocking_runs)"');
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

test("instalator przepuszcza trwałe human gate, ale blokuje aktywne wykonanie", () => {
  assert.match(
    script,
    /s\.lifecycle!=="finalized" && s\.lifecycle!=="awaiting_decision"/,
  );
  assert.match(
    script,
    /if\(s\.lifecycle==="awaiting_decision"\) ids\.add\(ticket\)/,
  );
  assert.ok(position('BLOCKING="$(find_blocking_runs)"') < position('bootout_agent "$SERVER_SERVICE"'));
  assert.ok(position('SUSPENDED="$(find_suspended_runs)"') < position('bootout_agent "$SERVER_SERVICE"'));
});

test("zaimportowany run v2 zastępuje legacy v1 przy ocenie bezpieczeństwa restartu", () => {
  assert.equal(
    script.match(/const ids=new Set\(\), imported=new Set\(\);/g)?.length,
    2,
    "obie klasyfikacje muszą traktować registry v2 jako źródło nadrzędne",
  );
  assert.equal(
    script.match(/if\(imported\.has\(ticket\)\) continue;/g)?.length,
    2,
    "zaimportowany ticket nie może być ponownie klasyfikowany z read-only state v1",
  );
  assert.match(script, /SELECT ticket_id, status FROM lifecycle_runs/);
});

test("nieudany bootstrap nie akceptuje starego joba jako sukcesu", () => {
  assert.doesNotMatch(
    script,
    /if launchctl print[^}]+then\s+return 0/s,
    "stary job launchd nie może maskować nieudanego bootstrapu",
  );
});

test("skrypt i szablony plistów nie mają zahardcodowanych ścieżek hosta", () => {
  assert.doesNotMatch(script, /\/Users\//, "skrypt nie może zawierać ścieżek użytkownika");
  assert.doesNotMatch(script, /\/opt\/homebrew\/bin\/(npm|node)/, "npm/node muszą być wykrywane, nie hardcodowane");
  assert.match(script, /command -v/, "wykrywanie toolchainu przez command -v");

  for (const name of ["com.ai-factory.server.plist.template", "com.ai-factory.poller.plist.template"]) {
    const template = readFileSync(join(here, "../../ops", name), "utf8");
    assert.doesNotMatch(template, /\/Users\//, `${name}: ścieżki hosta tylko przez placeholdery`);
    assert.match(template, /@@NPM_BIN@@/, `${name}: npm z detekcji`);
    assert.match(template, /@@FACTORY_DIR@@/, `${name}: katalog fabryki z położenia repo`);
    assert.match(template, /@@HOME@@/, `${name}: logi pod $HOME`);
    assert.match(template, /@@SERVICE_PATH@@/, `${name}: PATH usługi budowany per host`);
  }
});

test("--render-only generuje plisty z wykrytego toolchainu bez dotykania launchd", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-launchd-render-"));
  const fakeBin = join(root, "bin");
  const outDir = join(root, "out");
  const launchctlLog = join(root, "launchctl.log");
  try {
    mkdirSync(fakeBin);
    for (const name of ["npm", "node", "claude"]) {
      writeFileSync(join(fakeBin, name), "#!/bin/bash\nexit 0\n");
      chmodSync(join(fakeBin, name), 0o755);
    }
    writeFileSync(join(fakeBin, "launchctl"), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"\n');
    chmodSync(join(fakeBin, "launchctl"), 0o755);

    const result = spawnSync("/bin/bash", [scriptPath, "--render-only", outDir], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        LAUNCHCTL_LOG: launchctlLog,
      },
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(existsSync(launchctlLog), false, "render-only nie może wołać launchctl");

    const factoryDir = join(here, "../..");
    const server = readFileSync(join(outDir, "com.ai-factory.server.plist"), "utf8");
    const poller = readFileSync(join(outDir, "com.ai-factory.poller.plist"), "utf8");
    for (const rendered of [server, poller]) {
      assert.ok(!rendered.includes("@@"), "wszystkie placeholdery muszą być podstawione");
      assert.ok(rendered.includes(`<string>${join(fakeBin, "npm")}</string>`), "npm z command -v");
      assert.ok(rendered.includes(`<string>${factoryDir}</string>`), "WorkingDirectory z położenia repo");
      // PATH usługi: wykryty katalog node/npm dochodzi przed katalogami z $HOME
      assert.ok(rendered.includes(`<string>${fakeBin}:${root}/.local/bin:`), "PATH per host");
    }
    assert.ok(server.includes(`<string>${join(fakeBin, "claude")}</string>`), "CLAUDE_BIN z detekcji");
    assert.ok(server.includes(`${root}/.ai-factory/logs/server.log`), "logi pod $HOME hosta");
    assert.ok(poller.includes("FACTORY_CB_USD_PER_H"), "konfiguracja breakera pollera zostaje");
    assert.ok(poller.includes(`${root}/.ai-factory/logs/poller.log`), "logi pollera pod $HOME hosta");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
