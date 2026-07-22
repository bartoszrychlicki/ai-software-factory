import test from "node:test";
import assert from "node:assert/strict";
import { withPreviewLock } from "../pipeline/screenshot";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("preview na tym samym URL jest serializowany między równoległymi ticketami", async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];

  const run = (id: string) => withPreviewLock("http://localhost:4173/", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${id}`);
    await pause(10);
    order.push(`end:${id}`);
    active -= 1;
  });

  await Promise.all([run("A"), run("B"), run("C")]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"]);
});

test("błąd podglądu zwalnia kolejkę dla następnego ticketu", async () => {
  await assert.rejects(
    withPreviewLock("http://localhost:4174/", async () => { throw new Error("preview failed"); }),
    /preview failed/,
  );

  let ran = false;
  await withPreviewLock("http://localhost:4174/", async () => { ran = true; });
  assert.equal(ran, true);
});
