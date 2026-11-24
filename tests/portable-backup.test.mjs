import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, initDb } from "../server/db.mjs";
import { Store } from "../server/store.mjs";
import { newSession } from "../server/auth.mjs";
import { exportData, importData } from "../server/portable-backup.mjs";
const adminId = "900001234";
function real() {
  const db = openDb(":memory:");
  initDb(db, { production: true, demo: false, adminId });
  const store = new Store(db);
  return { db, store, actor: store.users()[0] };
}
test("portable export preserves documents, history and identities and omits login sessions", () => {
  const a = real(),
    b = real();
  try {
    const doc = a.store.create(a.actor, {
      title: "Перенос",
      categoryId: "category-6",
      dueDate: "2099-01-31",
      topic: "Тема",
    });
    a.store.action(a.actor, doc.id, "ready", { version: doc.version });
    newSession(a.db, a.actor.id);
    const snapshot = exportData(a.db);
    assert(!snapshot.tables.sessions);
    importData(b.db, snapshot, adminId);
    assert.deepEqual(b.store.documents(), a.store.documents());
    assert.deepEqual(
      b.store.state(b.store.user(a.actor.id)).audit,
      a.store.state(a.actor).audit,
    );
    assert.equal(b.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
    assert.equal(importData(b.db, snapshot, adminId).alreadyImported, true);
    assert.throws(
      () => importData(b.db, { ...snapshot, exportedAt: "different" }, adminId),
      /уже перенесена/,
    );
  } finally {
    a.db.close();
    b.db.close();
  }
});
test("portable import refuses nonempty targets and invalid structures without losing any data", () => {
  const a = real(),
    b = real();
  try {
    const snapshot = exportData(a.db);
    const before = exportData(b.db);
    const broken = structuredClone(snapshot);
    broken.tables.users[0].extra = "invalid";
    assert.throws(() => importData(b.db, broken, adminId), /структура/);
    assert.deepEqual(exportData(b.db).tables, before.tables);
    const doc = b.store.create(b.actor, {
      title: "Не заменять",
      categoryId: "category-2",
      dueDate: "2099-11-30",
    });
    assert.throws(() => importData(b.db, snapshot, adminId), /уже содержит/);
    assert.equal(b.store.document(doc.id).title, "Не заменять");
  } finally {
    a.db.close();
    b.db.close();
  }
});
test("demo promotion is explicit, keeps the source and history, and grants access only to a real administrator", () => {
  const db = openDb(":memory:");
  initDb(db, { demo: true });
  const store = new Store(db);
  const target = real();
  try {
    const doc = store.create(store.user("worker-1"), {
      title: "Ранее внесённый документ",
      categoryId: "category-2",
      dueDate: "2099-11-30",
    });
    const before = store.state(store.user("worker-1"));
    assert.throws(() => exportData(db), /явного подтверждения/);
    assert.throws(
      () => exportData(db, { promoteDemoAdminId: "900000001" }),
      /настоящий/,
    );
    const promoted = exportData(db, { promoteDemoAdminId: adminId });
    assert.equal(
      db.prepare("SELECT value FROM meta WHERE key='demo'").get().value,
      "true",
    );
    assert.equal(store.user("worker-1").active, true);
    assert.equal(promoted.tables.users.filter((u) => u.active).length, 1);
    assert.equal(
      promoted.tables.users.find((u) => u.active).telegram_id,
      adminId,
    );
    importData(target.db, promoted, adminId);
    assert.deepEqual(target.store.document(doc.id), store.document(doc.id));
    const actor = target.store.users().find((u) => u.active);
    assert.equal(actor.admin, true);
    assert.equal(target.store.user("worker-1").active, false);
    assert.deepEqual(target.store.state(actor).audit, before.audit);
  } finally {
    db.close();
    target.db.close();
  }
});
