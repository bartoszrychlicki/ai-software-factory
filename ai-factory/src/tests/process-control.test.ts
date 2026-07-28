import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileControlled } from "../pipeline/process-control";

test("AbortSignal kończy grupę procesu joba bez osieroconego dziecka", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-abort-"));
  const pidFile = join(dir, "child.pid");
  const controller = new AbortController();
  try {
    const running = execFileControlled(
      "bash",
      ["-c", `sleep 30 & child=$!; printf '%s' "$child" > "$1"; wait "$child"`, "abort-test", pidFile],
      { signal: controller.signal, timeoutMs: 20_000 }
    );
    for (let i = 0; i < 50; i += 1) {
      const ready = await readFile(pidFile, "utf8").catch(() => "");
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const childPid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    await assert.rejects(running, (error: Error & { terminationReason?: string }) => {
      assert.equal(error.terminationReason, "abort");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(childPid, 0));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
