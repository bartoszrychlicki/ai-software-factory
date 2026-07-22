import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registry from "../pipeline/run-registry";
import {
  acknowledgeOutboxFromRun,
  dispatchPendingOutbox,
  type WorkflowControlClient,
} from "../sources/mastra-client";

class FakeClient implements WorkflowControlClient {
  starts = 0;
  resumes = 0;
  failStart = true;
  async serverUp() { return true; }
  async createRun() { return "run-1"; }
  async startRun() {
    this.starts += 1;
    if (this.failStart) throw new Error("transport down");
  }
  async resumeRun() { this.resumes += 1; }
  async getRun() { return { status: "running" }; }
  async cancelRun() {}
}

test("trwały outbox ponawia błąd transportu i potwierdza postęp snapshotem", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-registry-"));
  process.env.FACTORY_RUNS_ROOT = root;
  try {
    const seed = { project: "pilot-app", runId: "run-1" };
    registry.enqueueOutbox("TEST-1", seed, {
      id: "start:run-1", kind: "start", body: { id: "TEST-1" },
    });
    const client = new FakeClient();

    await dispatchPendingOutbox(client, "TEST-1", seed);
    assert.equal(registry.readState("TEST-1")?.outbox["start:run-1"].state, "pending");
    assert.match(registry.readState("TEST-1")?.outbox["start:run-1"].lastError ?? "", /transport down/);

    client.failStart = false;
    await dispatchPendingOutbox(client, "TEST-1", seed);
    assert.equal(registry.readState("TEST-1")?.outbox["start:run-1"].state, "dispatched");
    acknowledgeOutboxFromRun("TEST-1", seed, { status: "running" });
    assert.equal(registry.readState("TEST-1")?.outbox["start:run-1"].state, "acknowledged");
    assert.equal(client.starts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.FACTORY_RUNS_ROOT;
  }
});

test("stary plan bez listy plików blokuje projekt wildcardem", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-collision-"));
  process.env.FACTORY_RUNS_ROOT = root;
  try {
    registry.recordFiles("TEST-OLD", { project: "pilot-app", runId: "old" }, ["*"]);
    const collisions = registry.fileCollisions("TEST-NEW", ["src/App.tsx"]);
    assert.deepEqual(collisions, [{ ticketId: "TEST-OLD", files: ["*"] }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.FACTORY_RUNS_ROOT;
  }
});

test("merge watcher tworzy od razu terminalny rekord dla historycznego ticketu", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-merge-state-"));
  process.env.FACTORY_RUNS_ROOT = root;
  try {
    registry.recordMergeHandled(
      "TEST-MERGED",
      { project: "pilot-app", runId: "legacy-merge:TEST-MERGED" },
      "merged"
    );
    const state = registry.readState("TEST-MERGED");
    assert.equal(state?.lifecycle, "finalized");
    assert.equal(state?.finalized?.outcome, "success");
    assert.deepEqual(registry.listUnfinished(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.FACTORY_RUNS_ROOT;
  }
});

test("manifest zachowuje kanoniczny URL ticketu po ponownym odczycie stanu", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-manifest-url-"));
  process.env.FACTORY_RUNS_ROOT = root;
  try {
    const canonicalUrl = "https://linear.app/acme/issue/BAR-164/test";
    registry.updateState("BAR-164", { project: "ai-factory", runId: "run-164" }, (state) => {
      state.manifest = { labels: ["domain:ops"], domain: "ops", url: canonicalUrl };
    });

    const restored = registry.readState("BAR-164");
    assert.equal(restored?.manifest?.url, canonicalUrl);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.FACTORY_RUNS_ROOT;
  }
});
