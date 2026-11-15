import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { initDb, openDb } from "../server/db.mjs";
import { Store } from "../server/store.mjs";

test("v3 upgrade adds the GDP rule immediately and preserves the checkpoint for catch-up", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-gdp-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [label, from, expected] of [
    ["same-day", "2026-11-15", 10],
    ["catch-up", "2026-11-02", 16],
  ]) {
    const path = join(dir, `${label}.sqlite`);
    let db = new DatabaseSync(path);
    for (const file of [
      "001_initial.sql",
      "002_document_categories.sql",
      "003_recurring_documents.sql",
    ])
      db.exec(
        readFileSync(
          new URL(`../server/migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
    initDb(db, { demo: true, production: false });
    const store = new Store(db, { clock: () => new Date(from + "T12:00:00Z") });
    assert.equal(store.syncRecurring(), 9);
    const original = store.documents();
    db.close();
    const app = createApp({
      database: path,
      demo: true,
      production: false,
      seed: false,
      automation: true,
      clock: () => new Date("2026-11-15T12:00:00Z"),
    });
    try {
      assert.equal(app.store.documents().length, expected);
      for (const old of original)
        assert.deepEqual(app.store.document(old.id), old);
      assert.equal(
        app.store.recurringRules().filter((r) => r.id === "weekly-gdp-report")
          .length,
        1,
      );
      assert.equal(app.store.syncRecurring(), 0);
      assert.equal(
        app.db
          .prepare("SELECT value FROM meta WHERE key='recurring_last_sync'")
          .get().value,
        "2026-11-15",
      );
    } finally {
      app.db.close();
    }
  }
});

function legacyDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), "vpr-categories-v1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(
      new URL("../server/migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  for (let i = 1; i <= 3; i++)
    db.prepare("INSERT INTO categories VALUES(?,?,?,0)").run(
      `category-${i}`,
      `Иконка №${i}`,
      i,
    );
  initDb(db, { demo: true, production: false });
  return { path, db };
}

test("new demo and production databases contain the twelve ordered document categories", () => {
  for (const config of [
    { demo: true, production: false },
    {
      demo: false,
      production: true,
      adminId: "123",
      botToken: "synthetic-token",
      origin: "https://example.test",
    },
  ]) {
    const { db, store } = createApp({
      automation: false,
      ...config,
      database: ":memory:",
      seed: false,
    });
    try {
      const categories = store.categories();
      assert.equal(categories.length, 12);
      assert.deepEqual(
        categories.map((c) => c.position),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      );
      assert.equal(categories[0].id, "category-1");
      assert.equal(
        categories[0].name,
        "Планы военно-политической работы на месяц и по конкретным (отдельным) задачам",
      );
      assert.equal(
        categories[1].name,
        "Планы основных культурно-досуговых мероприятий, проводимых с личным составом",
      );
      assert.equal(
        categories[6].name,
        "Социально-психологический портрет роты",
      );
      assert(categories[5].name.length > 100);
      assert.equal(categories[10].name, "Боевые листки");
      assert.equal(categories[11].name, "Рапорт ГДП");
      assert(categories.every((c) => !c.hidden));
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
    } finally {
      db.close();
    }
  }
});

test("v1 upgrade renames placeholders and adds categories while preserving documents, audit and review snapshots", (t) => {
  const { path, db } = legacyDatabase(t);
  const store = new Store(db, {
    clock: () => new Date("2026-11-27T12:00:00Z"),
  });
  const worker = store.user("worker-1");
  const document = store.create(worker, {
    title: "Существующий документ",
    categoryId: "category-1",
    dueDate: "2026-11-27",
  });
  store.action(worker, document.id, "place", {
    version: document.version,
    date: "2026-11-27",
  });
  store.review(store.user("chief-1"), { periodId: store.periodList()[0].id });
  const documents = db.prepare("SELECT * FROM documents").all();
  const audit = db.prepare("SELECT * FROM audit_events").all();
  const reviews = db.prepare("SELECT * FROM review_records").all();
  db.close();
  const upgraded = openDb(path);
  try {
    const categories = upgraded
      .prepare("SELECT * FROM categories ORDER BY position")
      .all();
    assert.equal(categories.length, 12);
    assert(categories[0].name.startsWith("Планы военно-политической работы"));
    assert(
      categories[1].name.startsWith(
        "Планы основных культурно-досуговых мероприятий",
      ),
    );
    assert(
      categories[2].name.startsWith(
        "Журнал учета грубых дисциплинарных проступков",
      ),
    );
    assert.deepEqual(
      upgraded.prepare("SELECT * FROM documents").all(),
      documents,
    );
    assert.deepEqual(
      upgraded.prepare("SELECT * FROM audit_events").all(),
      audit,
    );
    assert.deepEqual(
      upgraded.prepare("SELECT * FROM review_records").all(),
      reviews,
    );
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
});

test("category upgrade preserves custom names, visibility and order; restart does not overwrite later edits", (t) => {
  const { path, db } = legacyDatabase(t);
  db.prepare(
    "UPDATE categories SET name=?,position=40,hidden=1 WHERE id='category-2'",
  ).run("Своя категория");
  db.prepare(
    "INSERT INTO categories VALUES('custom-id','Дополнительная категория',50,1)",
  ).run();
  db.close();
  let upgraded = openDb(path);
  const custom = {
    id: "category-2",
    name: "Своя категория",
    position: 40,
    hidden: 1,
  };
  assert.deepEqual(
    {
      ...upgraded
        .prepare("SELECT * FROM categories WHERE id='category-2'")
        .get(),
    },
    custom,
  );
  assert.equal(
    upgraded.prepare("SELECT hidden FROM categories WHERE id='custom-id'").get()
      .hidden,
    1,
  );
  upgraded
    .prepare(
      "UPDATE categories SET name='Название после обновления',hidden=1 WHERE id='category-7'",
    )
    .run();
  const before = upgraded.prepare("SELECT * FROM categories ORDER BY id").all();
  upgraded.close();
  upgraded = openDb(path);
  try {
    assert.equal(before.length, 13);
    assert.deepEqual(
      upgraded.prepare("SELECT * FROM categories ORDER BY id").all(),
      before,
    );
  } finally {
    upgraded.close();
  }
});
