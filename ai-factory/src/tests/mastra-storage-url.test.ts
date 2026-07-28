import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveMastraStorageUrl } from "../mastra/storage-url";

test("lokalna baza workflow jest trwała poza bundlem Mastry", () => {
  assert.equal(
    resolveMastraStorageUrl(
      { FACTORY_ROOT: "/srv/ai-factory" },
      "/srv/ai-factory/.mastra/output"
    ),
    `file:${join("/srv/ai-factory", "runs", "mastra.db")}`
  );
});

test("jawny backend storage ma pierwszeństwo", () => {
  assert.equal(
    resolveMastraStorageUrl({
      TURSO_DATABASE_URL: "libsql://factory.example",
      FACTORY_MASTRA_DB_URL: "file:/ignored.db",
    }),
    "libsql://factory.example"
  );
  assert.equal(
    resolveMastraStorageUrl({ FACTORY_MASTRA_DB_URL: "file:/stable/mastra.db" }),
    "file:/stable/mastra.db"
  );
});
