import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registry from "../pipeline/run-registry";
import type { LinearCommandCandidate } from "../sources/linear";
import {
  MastraHttpError,
  type MastraRunSnapshot,
  type WorkflowControlClient,
} from "../sources/mastra-client";
import {
  MissingRunDetector,
  processRestartCommands,
  type RestartSource,
} from "../sources/run-recovery";

class FakeClient implements WorkflowControlClient {
  cancels = 0;
  cancelError: unknown = new MastraHttpError(
    404,
    "/workflows/ticketPipeline/runs/run-old",
    "Workflow run not found"
  );

  async serverUp() { return true; }
  async createRun() { return "run-new"; }
  async startRun() {}
  async resumeRun() {}
  async getRun(): Promise<MastraRunSnapshot> { return { status: "suspended" }; }
  async cancelRun() {
    this.cancels += 1;
    if (this.cancelError) throw this.cancelError;
  }
}

class FakeSource implements RestartSource {
  comments: string[] = [];
  states: string[] = [];

  constructor(public candidates: LinearCommandCandidate[]) {}

  async listCommandCandidates() { return this.candidates; }
  async comment(_id: string, body: string) { this.comments.push(body); }
  async setStateByName(_id: string, stateName: string) { this.states.push(stateName); }
}

test("trzy potwierdzone 404 oznaczają utracony run, timeout resetuje licznik", () => {
  const detector = new MissingRunDetector(3);
  const missing = new MastraHttpError(404, "/workflows/w/runs/gone", "Workflow run not found");
  assert.equal(detector.observe(missing), false);
  assert.equal(detector.observe(new Error("timeout")), false);
  assert.equal(detector.observe(missing), false);
  assert.equal(detector.observe(missing), false);
  assert.equal(detector.observe(missing), true);
});

test("/restart unieważnia brakujący run raz, zwalnia pliki i zachowuje idempotencję w nowym runie", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-restart-"));
  process.env.FACTORY_RUNS_ROOT = root;
  try {
    const seed = { project: "br-factory", runId: "run-old" };
    registry.updateState("BAR-TEST", seed, (state) => {
      state.lifecycle = "awaiting_decision";
      state.phase = "plan-approval";
    });
    registry.recordFiles("BAR-TEST", seed, ["src/shared.ts"]);
    const source = new FakeSource([{
      id: "BAR-TEST",
      stateName: "🔨 Build",
      stateType: "started",
      comments: [{
        id: "comment-restart-1",
        body: "/restart run zniknął",
        createdAt: "2099-01-01T00:00:00.000Z",
      }],
    }]);
    const client = new FakeClient();

    const first = await processRestartCommands({
      project: "br-factory",
      source,
      client,
      readyState: "Todo",
      factoryMarker: (id) => `[linear:${id}:v1]`,
    });
    const second = await processRestartCommands({
      project: "br-factory",
      source,
      client,
      readyState: "Todo",
      factoryMarker: (id) => `[linear:${id}:v1]`,
    });

    assert.deepEqual(first, ["BAR-TEST"]);
    assert.deepEqual(second, []);
    assert.equal(client.cancels, 1);
    assert.equal(source.comments.length, 1);
    assert.deepEqual(source.states, ["Todo"]);
    assert.equal(registry.readState("BAR-TEST")?.finalized?.reason, "restart");
    assert.ok(registry.readState("BAR-TEST")?.restartCommands?.["comment-restart-1"]?.handledAt);
    assert.deepEqual(registry.fileCollisions("OTHER", ["src/shared.ts"]), []);

    registry.updateState("BAR-TEST", { project: "br-factory", runId: "run-new" }, () => {});
    assert.ok(registry.readState("BAR-TEST")?.restartCommands?.["comment-restart-1"]?.handledAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.FACTORY_RUNS_ROOT;
  }
});

test("/restart nie uruchamia nowego runu, dopóki anulowanie nie zostanie potwierdzone", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-restart-pending-"));
  process.env.FACTORY_RUNS_ROOT = root;
  try {
    registry.updateState("BAR-TEST", { project: "br-factory", runId: "run-live" }, () => {});
    const source = new FakeSource([{
      id: "BAR-TEST",
      stateName: "🔨 Build",
      stateType: "started",
      comments: [{
        id: "comment-restart-2",
        body: "/restart",
        createdAt: "2099-01-01T00:00:00.000Z",
      }],
    }]);
    const client = new FakeClient();
    client.cancelError = new Error("transport down");

    const result = await processRestartCommands({
      project: "br-factory",
      source,
      client,
      readyState: "Todo",
      factoryMarker: (id) => `[linear:${id}:v1]`,
    });

    assert.deepEqual(result, []);
    assert.deepEqual(source.states, []);
    assert.equal(registry.readState("BAR-TEST")?.lifecycle, "running");
    assert.match(
      registry.readState("BAR-TEST")?.restartCommands?.["comment-restart-2"]?.lastError ?? "",
      /transport down/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.FACTORY_RUNS_ROOT;
  }
});
