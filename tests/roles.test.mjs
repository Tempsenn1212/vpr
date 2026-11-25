import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { Store } from "../server/store.mjs";
import { initDb, openDb } from "../server/db.mjs";
import { exportData, importData } from "../server/portable-backup.mjs";
import {
  workerPermissions,
  chiefPermissions,
  can,
} from "../shared/permissions.ts";
async function fixture(t) {
  const app = createApp({
    database: ":memory:",
    demo: true,
    production: false,
    seed: false,
    automation: false,
    clock: () => new Date("2026-11-27T12:00:00Z"),
  });
  const server = app.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    app.db.close();
  });
  const url = "http://127.0.0.1:" + server.address().port;
  app.config.origin = url;
  async function login(userId) {
    const r = await fetch(url + "/api/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    return (await r.json()).sessionToken;
  }
  const admin = await login("worker-1"),
    worker = await login("worker-2");
  async function call(
    path,
    data,
    token = admin,
    method = "POST",
    key = randomUUID(),
  ) {
    const r = await fetch(url + "/api" + path, {
      method: data === undefined ? "GET" : method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  }
  async function role(name, permissions) {
    const r = await call("/roles", { name, permissions });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  async function assign(roleId, userId = "worker-2") {
    const u = app.store.user(userId);
    const r = await call(
      "/users/" + userId,
      { name: u.name, telegramId: u.telegram_id, role: roleId, active: true },
      admin,
      "PATCH",
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  }
  return { ...app, url, call, role, assign, admin, worker, login };
}
test("role creation/rename preserves identities, applies to members, validates unique names and protects concurrent edits", async (t) => {
  const f = await fixture(t);
  const r = await f.role("Регистратор", ["documents.ready"]);
  await f.assign(r.id);
  const key = randomUUID(),
    body = {
      version: r.version,
      name: "Исполнитель",
      permissions: ["documents.ready", "documents.place"],
    };
  const renamed = await f.call("/roles/" + r.id, body, f.admin, "PATCH", key);
  assert.equal(renamed.status, 200);
  assert.deepEqual(
    (await f.call("/roles/" + r.id, body, f.admin, "PATCH", key)).body,
    renamed.body,
  );
  const stale = await f.call(
    "/roles/" + r.id,
    { ...body, name: "Старая правка" },
    f.admin,
    "PATCH",
  );
  assert.equal(stale.status, 409);
  const state = (await f.call("/state", undefined, f.worker)).body;
  assert.equal(state.me.role, r.id);
  assert.equal(state.me.roleName, "Исполнитель");
  assert(state.me.permissions.includes("documents.place"));
  assert.equal(
    (await f.call("/roles", { name: "ИСПОЛНИТЕЛЬ", permissions: [] })).status,
    400,
  );
  assert.equal(
    (
      await f.call("/roles", {
        name: "Неизвестное право",
        permissions: ["admin.all"],
      })
    ).status,
    400,
  );
  assert.equal(
    f.db
      .prepare("SELECT count(*) AS n FROM audit_events WHERE type='ROLE'")
      .get().n,
    2,
  );
});
test("view-only custom role cannot mutate documents, sheets, permissions, users, categories, periods or backups", async (t) => {
  const f = await fixture(t);
  f.store.syncRecurring();
  const actor = f.store.user("worker-1");
  const doc = f.store.create(actor, {
    title: "Наблюдение",
    categoryId: "category-2",
    dueDate: "2026-11-27",
  });
  const group = f.store.documents().find((d) => d.categoryId === "category-9");
  const r = await f.role("Наблюдатель", []);
  await f.assign(r.id);
  const before = f.store.documents();
  const blocked = [
    [
      "/documents",
      { title: "Недопустимо", categoryId: "category-2", dueDate: "2026-11-27" },
      "POST",
    ],
    [
      "/documents/" + doc.id,
      {
        title: "Недопустимо",
        categoryId: "category-2",
        dueDate: doc.dueDate,
        version: 1,
      },
      "PATCH",
    ],
    ["/documents/" + doc.id, { confirmed: true, version: 1 }, "DELETE"],
    ...[
      "ready",
      "place",
      "return",
      "confirm",
      "reject",
      "revoke",
      "place-confirm",
    ].map((a) => [
      "/documents/" + doc.id + "/actions/" + a,
      { version: 1, date: "2026-11-27", confirmed: true, reason: "Причина" },
      "POST",
    ]),
    [
      "/documents/" + group.id + "/items/complete",
      { version: group.version },
      "POST",
    ],
    [
      "/documents/" + group.id + "/items/item-1",
      { version: group.version, done: true },
      "PATCH",
    ],
    [
      "/documents/" + group.id + "/items/item-1",
      { version: group.version, label: "Нельзя" },
      "PATCH",
    ],
    ["/roles", { name: "Захват прав", permissions: ["roles.manage"] }, "POST"],
    [
      "/users",
      {
        name: "Нельзя",
        telegramId: "123456",
        role: "CHIEF",
        active: true,
        admin: true,
      },
      "POST",
    ],
    ["/categories", { name: "Нельзя", position: 15, hidden: false }, "POST"],
    ["/schedule/preview", { anchor: "2026-11-13", interval: 14 }, "POST"],
    [
      "/schedule",
      { anchor: "2026-11-13", interval: 14, expectedVersion: "initial" },
      "POST",
    ],
    [
      "/recurring-rules/monthly-vpr",
      { version: 1, ready_day: 25, placement_day: 31, enabled: false },
      "PATCH",
    ],
    ["/reviews", { periodId: f.store.periodList()[0].id }, "POST"],
    [
      "/batches/confirm",
      { periodId: f.store.periodList()[0].id, categoryId: "ALL", items: [] },
      "POST",
    ],
    ["/admin/transfer", { userId: "worker-2" }, "POST"],
  ];
  for (const [path, data, method] of blocked)
    assert.equal(
      (await f.call(path, data, f.worker, method)).status,
      403,
      path,
    );
  assert.equal(
    (await f.call("/admin/export", undefined, f.worker)).status,
    403,
  );
  assert.deepEqual(f.store.documents(), before);
  const state = (await f.call("/state", undefined, f.worker)).body;
  assert.equal(state.documents.length, before.length);
  assert.equal(state.audit.length, 0);
  assert.equal(state.reviewRecords.length, 0);
  assert(!state.users.some((u) => u.telegram_id));
});
test("granular readiness/placement rights and immediate revocation apply to an already established session", async (t) => {
  const f = await fixture(t);
  const r = await f.role("Исполнитель", ["documents.ready", "documents.place"]);
  await f.assign(r.id);
  const actor = f.store.user("worker-1");
  const doc = f.store.create(actor, {
    title: "Проверка",
    categoryId: "category-2",
    dueDate: "2026-11-27",
  });
  const ready = await f.call(
    "/documents/" + doc.id + "/actions/ready",
    { version: 1 },
    f.worker,
  );
  assert.equal(ready.status, 200);
  assert.equal(
    (
      await f.call(
        "/documents/" + doc.id + "/actions/place-confirm",
        { version: 2, date: "2026-11-27" },
        f.worker,
      )
    ).status,
    403,
  );
  const placed = await f.call(
    "/documents/" + doc.id + "/actions/place",
    { version: 2, date: "2026-11-27" },
    f.worker,
  );
  assert.equal(placed.status, 200);
  assert.equal(
    (
      await f.call(
        "/documents/" + doc.id + "/actions/confirm",
        { version: 3 },
        f.worker,
      )
    ).status,
    403,
  );
  const revised = await f.call(
    "/roles/" + r.id,
    { ...r, permissions: [] },
    f.admin,
    "PATCH",
  );
  assert.equal(revised.status, 200);
  const next = f.store.create(actor, {
    title: "После отзыва",
    categoryId: "category-2",
    dueDate: "2026-11-27",
  });
  assert.equal(
    (
      await f.call(
        "/documents/" + next.id + "/actions/ready",
        { version: 1 },
        f.worker,
      )
    ).status,
    403,
  );
  assert.deepEqual(
    (await f.call("/state", undefined, f.worker)).body.me.permissions,
    [],
  );
});
test("custom supervisor can confirm, review, batch and configure schedule without a hard-coded CHIEF identity", async (t) => {
  const f = await fixture(t);
  const r = await f.role("Контролёр", chiefPermissions);
  await f.assign(r.id);
  const actor = f.store.user("worker-1");
  const d = f.store.create(actor, {
    title: "Проверка контролёра",
    categoryId: "category-2",
    dueDate: "2026-11-27",
  });
  f.store.action(actor, d.id, "place", { version: 1, date: "2026-11-27" });
  const period = f.store
    .periodList()
    .find((p) => p.start <= "2026-11-27" && p.end >= "2026-11-27");
  assert.equal(
    (
      await f.call(
        "/batches/confirm",
        {
          periodId: period.id,
          categoryId: "ALL",
          items: [{ id: d.id, version: 2 }],
        },
        f.worker,
      )
    ).body.confirmed,
    1,
  );
  assert.equal(
    (await f.call("/reviews", { periodId: period.id }, f.worker)).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/schedule/preview",
        { anchor: "2026-11-13", interval: 14 },
        f.worker,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        "/recurring-rules/monthly-vpr",
        {
          version: f.store.recurringRules().find((r) => r.id === "monthly-vpr")
            .version,
          ready_day: 24,
          placement_day: 31,
          enabled: true,
        },
        f.worker,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(f.store.user("worker-2").role, r.id);
});
test("delegated user management cannot escalate privileges or change the protected administrator; owner can recover an empty role", async (t) => {
  const f = await fixture(t);
  const r = await f.role("Менеджер участников", ["users.manage"]);
  await f.assign(r.id);
  const own = f.store.user("worker-2");
  assert.equal(
    (
      await f.call(
        "/users/worker-2",
        {
          name: own.name,
          telegramId: own.telegram_id,
          role: "CHIEF",
          active: true,
        },
        f.worker,
        "PATCH",
      )
    ).status,
    403,
  );
  const owner = f.store.user("worker-1");
  assert.equal(
    (
      await f.call(
        "/users/worker-1",
        {
          name: "Захват",
          telegramId: owner.telegram_id,
          role: r.id,
          active: true,
        },
        f.worker,
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/roles",
        { name: "Нельзя", permissions: ["roles.manage"] },
        f.worker,
      )
    ).status,
    403,
  );
  const original = f.store.roles().find((r) => r.id === "WORKER");
  assert.equal(
    (
      await f.call(
        "/roles/WORKER",
        { ...original, name: "Переименованная роль", permissions: [] },
        f.admin,
        "PATCH",
      )
    ).status,
    200,
  );
  const current = (await f.call("/state")).body.me;
  assert(current.admin);
  assert(can(current, "roles.manage"));
  assert(!can(current, "documents.confirm"));
  assert(!can(current, "documents.ready"));
  const saved = f.store.roles().find((r) => r.id === "WORKER");
  assert.equal(
    (
      await f.call(
        "/roles/WORKER",
        { ...saved, permissions: workerPermissions },
        f.admin,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(f.store.user("worker-1").roleName, "Переименованная роль");
  assert.equal(
    (
      await f.call(
        "/users/system-scheduler",
        { name: "Нельзя", telegramId: "123456", role: r.id, active: true },
        f.admin,
        "PATCH",
      )
    ).status,
    403,
  );
});
test("v7 migration preserves users, documents, audit, sessions and snapshots and persists role changes across reopen", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-roles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "v7.sqlite");
  let db = new DatabaseSync(path);
  for (const name of [
    "001_initial",
    "002_document_categories",
    "003_recurring_documents",
    "004_gdp_report",
    "005_plan_titles",
    "006_document_comments",
    "007_editable_lecture_topics",
  ])
    db.exec(
      readFileSync(
        new URL("../server/migrations/" + name + ".sql", import.meta.url),
        "utf8",
      ),
    );
  initDb(db, { demo: true });
  let store = new Store(db);
  const actor = store.user("worker-1");
  store.create(actor, {
    title: "Сохранить",
    categoryId: "category-2",
    dueDate: "2099-01-31",
  });
  store.review(store.user("chief-1"), { periodId: store.periodList()[0].id });
  const before = Object.fromEntries(
    ["users", "documents", "audit_events", "review_records", "sessions"].map(
      (table) => [
        table,
        db
          .prepare("SELECT * FROM " + table)
          .all()
          .map((r) => ({ ...r })),
      ],
    ),
  );
  db.close();
  db = openDb(path);
  store = new Store(db);
  for (const [table, rows] of Object.entries(before))
    assert.deepEqual(
      db
        .prepare("SELECT * FROM " + table)
        .all()
        .map((r) => ({ ...r })),
      rows,
    );
  assert.equal(can(store.user("chief-1"), "documents.confirm"), true);
  assert.equal(can(store.user("worker-1"), "documents.confirm"), false);
  const role = store.saveRole(store.user("worker-1"), null, {
    name: "Наблюдатель",
    permissions: [],
  });
  const old = store.user("worker-2");
  store.saveUser(store.user("worker-1"), old.id, {
    name: old.name,
    telegramId: old.telegram_id,
    active: true,
    role: role.id,
  });
  db.close();
  db = openDb(path);
  store = new Store(db);
  assert.equal(store.user("worker-2").role, role.id);
  assert.deepEqual(store.user("worker-2").permissions, []);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
  db.close();
});
test("portable backup v8 roundtrips custom roles/assignments; legacy v7 backup upgrades without losing data", () => {
  const source = openDb(":memory:"),
    target = openDb(":memory:"),
    legacyTarget = openDb(":memory:");
  const cfg = { demo: false, production: true, adminId: "900001234" };
  try {
    for (const db of [source, target, legacyTarget]) initDb(db, cfg);
    const store = new Store(source),
      actor = store.users()[0];
    store.create(actor, {
      title: "Копия",
      categoryId: "category-2",
      dueDate: "2099-01-31",
    });
    const legacy = exportData(source);
    legacy.schemaVersion = 7;
    delete legacy.tables.roles;
    delete legacy.tables.user_roles;
    const role = store.saveRole(actor, null, {
      name: "Контролёр",
      permissions: chiefPermissions,
    });
    const user = store.saveUser(actor, null, {
      name: "Контролёр",
      telegramId: "900005555",
      role: role.id,
      active: true,
    });
    const snapshot = exportData(source);
    assert.equal(snapshot.schemaVersion, 8);
    importData(target, snapshot, cfg.adminId);
    assert.deepEqual(new Store(target).user(user.id), store.user(user.id));
    importData(legacyTarget, legacy, cfg.adminId);
    assert.deepEqual(new Store(legacyTarget).documents(), store.documents());
    assert.equal(new Store(legacyTarget).roles().length, 2);
    assert.equal(
      importData(legacyTarget, legacy, cfg.adminId).alreadyImported,
      true,
    );
  } finally {
    source.close();
    target.close();
    legacyTarget.close();
  }
});
