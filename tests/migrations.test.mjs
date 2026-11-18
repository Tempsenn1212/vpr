import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { initDb, openDb } from "../server/db.mjs";
import { Store } from "../server/store.mjs";
import { randomUUID } from "node:crypto";

test("v5 comments migration preserves documents and snapshots and discussions survive reopening", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-comments-v5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "comments.sqlite");
  let db = new DatabaseSync(path);
  for (const file of [
    "001_initial.sql",
    "002_document_categories.sql",
    "003_recurring_documents.sql",
    "004_gdp_report.sql",
    "005_plan_titles.sql",
  ])
    db.exec(
      readFileSync(
        new URL(`../server/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  initDb(db, { demo: true, production: false });
  let store = new Store(db, { clock: () => new Date("2026-11-27T12:00:00Z") });
  const actor = store.user("worker-1");
  const d = store.create(actor, {
    title: "Документ до комментариев",
    categoryId: "category-9",
    dueDate: "2026-11-27",
  });
  store.review(store.user("chief-1"), { periodId: store.periodList()[0].id });
  const documents = db.prepare("SELECT * FROM documents").all(),
    audit = db.prepare("SELECT * FROM audit_events ORDER BY seq").all(),
    reviews = db.prepare("SELECT * FROM review_records").all();
  db.close();
  db = openDb(path);
  store = new Store(db, { clock: () => new Date("2026-11-27T12:00:00Z") });
  assert.deepEqual(db.prepare("SELECT * FROM documents").all(), documents);
  assert.deepEqual(
    db.prepare("SELECT * FROM audit_events ORDER BY seq").all(),
    audit,
  );
  assert.deepEqual(db.prepare("SELECT * FROM review_records").all(), reviews);
  assert.deepEqual(store.comments(), []);
  const comment = store.mutate(
    actor,
    randomUUID(),
    "POST /comments",
    { text: "Сохранённое пояснение" },
    (a) => store.addComment(a, d.id, { text: "Сохранённое пояснение" }),
  );
  db.close();
  db = openDb(path);
  try {
    store = new Store(db);
    assert.deepEqual(store.comments(), [comment]);
    assert.deepEqual(db.prepare("SELECT * FROM documents").all(), documents);
    assert.deepEqual(db.prepare("SELECT * FROM review_records").all(), reviews);
    assert.equal(
      store.state(actor).audit.filter((e) => e.type === "COMMENT").length,
      1,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
  } finally {
    db.close();
  }
});

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
      for (const old of original) {
        const current = app.store.document(old.id);
        if (old.categoryId === "category-6") {
          assert.equal(
            current.title,
            old.title[0] + old.title.slice(1).toLocaleLowerCase("ru"),
          );
          assert.equal(current.version, old.version + 1);
          assert.deepEqual(
            {
              ...current,
              title: old.title,
              version: old.version,
              updatedAt: old.updatedAt,
            },
            old,
          );
        } else assert.deepEqual(current, old);
      }
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

test("v4 plan headings migrate once with audit and preserve facts, custom names, rules and review snapshots", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-plan-titles-v4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "plans.sqlite");
  let db = new DatabaseSync(path);
  for (const file of [
    "001_initial.sql",
    "002_document_categories.sql",
    "003_recurring_documents.sql",
    "004_gdp_report.sql",
  ])
    db.exec(
      readFileSync(
        new URL(`../server/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  initDb(db, { demo: true, production: false });
  let store = new Store(db, { clock: () => new Date("2026-11-15T12:00:00Z") });
  store.syncRecurring();
  const worker = store.user("worker-1"),
    chief = store.user("chief-1");
  const plans = store.documents().filter((d) => d.categoryId === "category-6");
  store.action(worker, plans[0].id, "ready", {
    version: plans[0].version,
    date: "2026-11-13",
  });
  store.action(chief, plans[1].id, "place-confirm", {
    version: plans[1].version,
    date: "2026-11-14",
  });
  store.action(worker, plans[2].id, "place", {
    version: plans[2].version,
    date: "2026-11-14",
  });
  const oldTitle = "ПЛАН ПРОВЕДЕНИЯ ВОСКРЕСНОГО ЛЕКТОРИЯ";
  const manual = store.create(worker, {
    categoryId: "category-6",
    title: oldTitle,
    dueDate: "2026-11-20",
    topic: "Тема, заданная пользователем",
  });
  store.create(worker, {
    categoryId: "category-6",
    title: "Мой план: ВАЖНАЯ ТЕМА",
    dueDate: "2026-11-20",
  });
  store.create(worker, {
    categoryId: "category-2",
    title: oldTitle,
    dueDate: "2026-11-20",
  });
  const deleted = store.create(worker, {
    categoryId: "category-6",
    title: oldTitle,
    dueDate: "2026-11-20",
  });
  store.remove(worker, deleted.id, {
    version: deleted.version,
    confirmed: true,
  });
  db.prepare(
    "UPDATE recurring_rules SET enabled=0,ready_day=6,placement_day=7 WHERE id='evening-friday'",
  ).run();
  db.prepare(
    "INSERT INTO recurring_rules(id,category_id,title,cadence,ready_day,placement_day) VALUES('custom-rule','category-6','МОЙ ПЛАН','weekly',3,7)",
  ).run();
  store.review(chief, {
    periodId: store
      .periodList()
      .find((p) => p.start <= manual.dueDate && p.end >= manual.dueDate).id,
  });
  const original = store.documents();
  const rulesBefore = store.recurringRules();
  const auditBefore = db
    .prepare("SELECT * FROM audit_events ORDER BY seq")
    .all();
  const snapshots = db.prepare("SELECT * FROM review_records").all();
  const occurrences = db
    .prepare("SELECT * FROM recurring_occurrences ORDER BY document_id")
    .all();
  const checkpoint = db
    .prepare("SELECT value FROM meta WHERE key='recurring_last_sync'")
    .get().value;
  db.close();
  db = openDb(path);
  store = new Store(db, { clock: () => new Date("2026-11-15T12:00:00Z") });
  const renamed = [];
  for (const old of original) {
    const current = store.document(old.id);
    if (
      old.categoryId === "category-6" &&
      !old.deleted &&
      old.title.startsWith("ПЛАН ПРОВЕДЕНИЯ ")
    ) {
      renamed.push(old.id);
      assert.equal(
        current.title,
        old.title[0] + old.title.slice(1).toLocaleLowerCase("ru"),
      );
      assert.equal(current.version, old.version + 1);
      assert.deepEqual(
        {
          ...current,
          title: old.title,
          version: old.version,
          updatedAt: old.updatedAt,
        },
        old,
      );
    } else assert.deepEqual(current, old);
  }
  for (const rule of rulesBefore) {
    const current = store.recurringRules().find((r) => r.id === rule.id);
    const standard =
      rule.category_id === "category-6" &&
      rule.title.startsWith("ПЛАН ПРОВЕДЕНИЯ ");
    assert.deepEqual(
      { ...current },
      standard
        ? {
            ...rule,
            title: rule.title[0] + rule.title.slice(1).toLocaleLowerCase("ru"),
            version: rule.version + 1,
          }
        : { ...rule },
    );
  }
  const audit = db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
  assert.deepEqual(audit.slice(0, auditBefore.length), auditBefore);
  const changes = audit.slice(auditBefore.length);
  assert.equal(changes.length, renamed.length);
  for (const event of changes) {
    assert.equal(event.type, "RENAME");
    assert.equal(event.actor_id, "system-scheduler");
    const data = JSON.parse(event.data);
    assert.deepEqual(
      data.before,
      original.find((d) => d.id === event.document_id),
    );
    assert.deepEqual(data.after, store.document(event.document_id));
    assert(data.categoryNames["category-6"]);
  }
  assert.deepEqual(db.prepare("SELECT * FROM review_records").all(), snapshots);
  assert.deepEqual(
    db
      .prepare("SELECT * FROM recurring_occurrences ORDER BY document_id")
      .all(),
    occurrences,
  );
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key='recurring_last_sync'").get()
      .value,
    checkpoint,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const after = store.documents(),
    rulesAfter = store.recurringRules();
  db.close();
  db = openDb(path);
  try {
    store = new Store(db);
    assert.deepEqual(store.documents(), after);
    assert.deepEqual(store.recurringRules(), rulesAfter);
    assert.deepEqual(
      db.prepare("SELECT * FROM audit_events ORDER BY seq").all(),
      audit,
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
  } finally {
    db.close();
  }
});

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
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
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
