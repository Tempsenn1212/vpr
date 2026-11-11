import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createApp } from "../server/app.mjs";
test("20: online backup includes WAL and restores data, audit and administrator", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source.sqlite"),
    destination = join(dir, "backup.sqlite");
  const first = createApp({
    database: source,
    demo: true,
    production: false,
    seed: false,
  });
  const actor = first.store.user("worker-1");
  const document = first.store.create(actor, {
    title: "Копия из WAL",
    dueDate: "2026-11-27",
    categoryId: "category-1",
  });
  execFileSync(process.execPath, ["scripts/backup.mjs", destination], {
    env: { ...process.env, DATABASE_PATH: source },
  });
  first.db.close();
  const restored = createApp({
    database: destination,
    demo: true,
    production: false,
    seed: false,
  });
  assert.equal(restored.store.document(document.id).title, "Копия из WAL");
  assert.equal(restored.store.user("worker-1").admin, true);
  assert.equal(restored.store.state(actor).audit.length, 1);
  restored.db.close();
  assert.throws(
    () =>
      createApp({
        database: destination,
        demo: false,
        production: true,
        botToken: "synthetic-test-token",
        origin: "https://example.test",
      }),
    /синтетической/,
  );
});
