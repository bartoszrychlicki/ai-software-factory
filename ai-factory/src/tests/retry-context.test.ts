import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRetryEvidence } from "../sources/retry-context";

const artifact = (meta: Record<string, string>, body: string) =>
  `---\n${Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}`;

test("retry przenosi ostatni verifier, scope violation i najnowszy commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-retry-context-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "build-attempt-1.md"),
      artifact({ outcome: "committed", sha: "a".repeat(40) }, "pierwsza implementacja")
    );
    writeFileSync(
      join(dir, "verify-attempt-1.md"),
      artifact({ outcome: "fail" }, "brakuje podpisu planera")
    );
    writeFileSync(
      join(dir, "build-attempt-2.md"),
      artifact({ outcome: "scope-violation" }, "potrzebny src/pipeline/ticket-pipeline.ts")
    );
    // Kolejność nie może zależeć od mtime: na runnerach CI oba pliki często
    // dostają identyczny timestamp.
    const sameTime = new Date("2026-07-28T10:00:00.000Z");
    utimesSync(join(dir, "build-attempt-1.md"), sameTime, sameTime);
    utimesSync(join(dir, "build-attempt-2.md"), sameTime, sameTime);

    const evidence = readRetryEvidence(dir);
    assert.equal(evidence?.baseSha, "a".repeat(40));
    assert.match(evidence?.context ?? "", /brakuje podpisu planera/);
    assert.match(evidence?.context ?? "", /ticket-pipeline\.ts/);
    assert.equal(evidence?.requiresChanges, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zielony verifier pozwala wznowić checkpoint bez ponownego buildera", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-retry-pass-"));
  try {
    writeFileSync(
      join(dir, "build-attempt-1.md"),
      artifact({ outcome: "committed", sha: "b".repeat(40) }, "gotowe")
    );
    writeFileSync(
      join(dir, "verify-attempt-1.md"),
      artifact({ outcome: "pass" }, "wszystko zielone")
    );

    const evidence = readRetryEvidence(dir);
    assert.equal(evidence?.baseSha, "b".repeat(40));
    assert.equal(evidence?.requiresChanges, false);
    assert.equal(evidence?.context, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
