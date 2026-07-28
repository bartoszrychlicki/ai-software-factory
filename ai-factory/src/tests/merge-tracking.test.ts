import test from "node:test";
import assert from "node:assert/strict";
import { currentTrackedPrUrl } from "../sources/merge-tracking";

const marker = "[linear:BAR-168:v1]";
const stale = {
  body: `✅ Stary wynik ${marker}. PR: https://github.com/acme/repo/pull/10`,
};

test("aktywny run review nie dziedziczy starego URL-a PR z komentarzy", () => {
  assert.equal(
    currentTrackedPrUrl(
      { lifecycle: "running", prUrl: undefined },
      [stale],
      marker
    ),
    undefined
  );
});

test("run zakończony nie jest śledzony bez własnego trwałego prUrl", () => {
  assert.equal(
    currentTrackedPrUrl(
      { lifecycle: "finalized", finalized: { outcome: "success" } },
      [stale],
      marker
    ),
    undefined
  );
});

test("merge-watcher używa wyłącznie PR-a bieżącego udanego runu", () => {
  assert.equal(
    currentTrackedPrUrl(
      {
        lifecycle: "finalized",
        finalized: { outcome: "success" },
        prUrl: "https://github.com/acme/repo/pull/21",
      },
      [stale],
      marker
    ),
    "https://github.com/acme/repo/pull/21"
  );
});

test("fallback komentarzy działa tylko dla ticketu bez trwałego rejestru", () => {
  assert.equal(
    currentTrackedPrUrl(
      undefined,
      [
        stale,
        { body: `✅ Nowszy wynik ${marker}. PR: https://github.com/acme/repo/pull/11` },
      ],
      marker
    ),
    "https://github.com/acme/repo/pull/11"
  );
});
