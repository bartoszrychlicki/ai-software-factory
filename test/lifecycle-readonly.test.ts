import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LifecycleStore, type TicketManifestV2 } from "../src/lifecycle/store";

const manifest: TicketManifestV2 = {
  title: "Read-only MCP",
  description: "",
  labels: [],
  inputHash: "hash",
};

function tempDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "factory-lifecycle-ro-"));
  const path = join(dir, "lifecycle.db");
  return { dir, path };
}

test("czytelnik widzi run i nie modyfikuje pliku bazy", () => {
  const { dir, path } = tempDatabase();
  try {
    const writer = new LifecycleStore(path);
    writer.createRun("BAR-RO-1", "harness", manifest);
    writer.close();
    const before = statSync(path).mtimeMs;

    const reader = new LifecycleStore(path, { readOnly: true });
    assert.equal(reader.getRun("BAR-RO-1")?.ticketId, "BAR-RO-1");
    reader.close();

    assert.equal(statSync(path).mtimeMs, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wszystkie publiczne ścieżki zapisu są twardo zablokowane w read-only", () => {
  const { dir, path } = tempDatabase();
  try {
    const writer = new LifecycleStore(path);
    writer.createRun("BAR-RO-2", "harness", manifest);
    writer.close();
    const reader = new LifecycleStore(path, { readOnly: true });
    const blocked = (action: () => unknown) => assert.throws(action, /LifecycleStore otwarty read-only/);

    blocked(() => reader.createRun("BAR-RO-3", "harness", manifest));
    blocked(() => reader.transition("BAR-RO-2", {
      stage: "build",
      status: "running",
      actor: "test",
      reason: "must-fail",
    }));
    blocked(() => reader.enqueue({
      key: "BAR-RO-2:g1:plan:run-job",
      ticketId: "BAR-RO-2",
      kind: "run-job",
      stage: "plan",
      payload: {},
    }));
    blocked(() => reader.deferCommand("missing", new Date().toISOString()));
    blocked(() => reader.markCommand("missing", "done"));
    blocked(() => reader.startAttempt("BAR-RO-2", "plan", 1, "job-1"));
    blocked(() => reader.finishAttempt("BAR-RO-2", "plan", 1, { status: "success" }));
    blocked(() => reader.setScore("BAR-RO-2", 5));
    blocked(() => reader.markCommentProcessed("BAR-RO-2", "comment-1"));
    blocked(() => reader.claimLease(123));
    blocked(() => reader.renewLease(123));
    blocked(() => reader.releaseLease(123));
    blocked(() => reader.backupTo(join(dir, "backup.db")));
    assert.equal(existsSync(join(dir, "backup.db")), false);
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brak lifecycle.db daje czytelny błąd i nie tworzy pliku", () => {
  const { dir, path } = tempDatabase();
  try {
    assert.throws(
      () => new LifecycleStore(path, { readOnly: true }),
      /Fabryka nie ma jeszcze rejestru lifecycle: brak pliku/
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stary schemat read-only daje czytelny błąd i nie uruchamia migracji", () => {
  const { dir, path } = tempDatabase();
  let inspection: DatabaseSync | undefined;
  try {
    const writer = new LifecycleStore(path);
    writer.close();
    const oldSchema = new DatabaseSync(path);
    oldSchema.exec("ALTER TABLE lifecycle_runs DROP COLUMN review_report");
    oldSchema.close();

    assert.throws(
      () => new LifecycleStore(path, { readOnly: true }),
      /niekompatybilny schemat.*uruchom poller/i
    );

    inspection = new DatabaseSync(path, { readOnly: true });
    const columns = inspection.prepare("PRAGMA table_info(lifecycle_runs)").all() as {
      name: string;
    }[];
    assert.equal(columns.some((column) => column.name === "review_report"), false);
  } finally {
    inspection?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader nie blokuje się podczas otwartej transakcji writera w WAL", () => {
  const { dir, path } = tempDatabase();
  let rawWriter: DatabaseSync | undefined;
  let reader: LifecycleStore | undefined;
  try {
    const writer = new LifecycleStore(path);
    writer.createRun("BAR-RO-4", "harness", manifest);
    writer.close();

    rawWriter = new DatabaseSync(path);
    rawWriter.exec("BEGIN IMMEDIATE");
    rawWriter.prepare(
      "UPDATE lifecycle_runs SET status='blocked' WHERE ticket_id='BAR-RO-4'"
    ).run();

    reader = new LifecycleStore(path, { readOnly: true });
    assert.equal(reader.getRun("BAR-RO-4")?.status, "pending");
    rawWriter.exec("ROLLBACK");
  } finally {
    reader?.close();
    try {
      rawWriter?.exec("ROLLBACK");
    } catch {
      // Transakcja została już zamknięta.
    }
    rawWriter?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
