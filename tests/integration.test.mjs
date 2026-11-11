import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { validateTelegram } from "../server/auth.mjs";
const fixed = () => new Date("2026-11-27T12:00:00Z");
async function fixture(t, extra = {}) {
  const instance = createApp({
    database: ":memory:",
    demo: true,
    production: false,
    seed: false,
    clock: fixed,
    ...extra,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    instance.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const client = (initialCookie = "") => {
    let cookie = initialCookie;
    return {
      get cookie() {
        return cookie;
      },
      async request(path, body, method = "POST", key = randomUUID()) {
        const r = await fetch(base + path, {
          method: body === undefined ? "GET" : method,
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (r.headers.get("set-cookie"))
          cookie = r.headers.get("set-cookie").split(";")[0];
        return { status: r.status, data: await r.json() };
      },
      async login(id) {
        const r = await this.request("/auth/demo", { userId: id });
        assert.equal(r.status, 200);
        return this;
      },
    };
  };
  const worker = await client().login("worker-1"),
    other = await client().login("worker-2"),
    chief = await client().login("chief-1");
  const create = async (b = {}) => {
    const r = await worker.request("/documents", {
      title: "Тестовый документ",
      categoryId: "category-1",
      dueDate: "2026-11-27",
      ...b,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  const action = async (c, d, a, b = {}) => {
    const r = await c.request(`/documents/${d.id}/actions/${a}`, {
      version: d.version,
      ...b,
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  return { ...instance, base, client, worker, other, chief, create, action };
}
test("1: unknown caller and forged role cannot read or mutate", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client().request("/state")).status, 401);
  const d = await f.create();
  const p = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  assert.equal(
    (
      await f.worker.request(`/documents/${d.id}/actions/confirm`, {
        version: p.version,
        role: "CHIEF",
        userId: "chief-1",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.client().request("/auth/demo", { userId: "unknown" })).status,
    403,
  );
});
test("2,3: four workers share data; second worker performs marks with correct author", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.other, d, "ready");
  assert.equal(d.ready.userId, "worker-2");
  d = await f.action(f.other, d, "place", { date: "2026-11-26" });
  assert.equal(d.placement.userId, "worker-2");
  assert.equal(d.createdBy.userId, "worker-1");
  for (let i = 1; i <= 4; i++) {
    const c = await f.client().login(`worker-${i}`);
    const r = await c.request("/state");
    assert.equal(r.data.documents[0].id, d.id);
  }
});
test("3: title/due/category validations on API; past deadlines and duplicate titles allowed", async (t) => {
  const f = await fixture(t);
  for (const b of [
    { title: "   " },
    { title: "x".repeat(201) },
    { dueDate: "" },
    { dueDate: "2026-02-30" },
    { categoryId: "missing" },
  ])
    assert.equal(
      (
        await f.worker.request("/documents", {
          title: "Документ",
          dueDate: "2026-11-20",
          categoryId: "category-1",
          ...b,
        })
      ).status,
      400,
    );
  await f.create({ dueDate: "2020-01-01" });
  await f.create({ dueDate: "2020-01-01" });
  assert.equal(f.store.documents().length, 2);
});
test("4,5,6: READY overdue; direct past placement before creation has no fake mark; future rejected", async (t) => {
  const f = await fixture(t);
  const d = await f.create({ dueDate: "2026-11-20" });
  let ready = await f.action(f.worker, d, "ready");
  let state = (await f.worker.request("/state")).data;
  assert.equal(state.documents[0].deadline.kind, "overdue");
  assert.equal(
    (
      await f.worker.request(`/documents/${d.id}/actions/place`, {
        version: ready.version,
        date: "2026-11-28",
      })
    ).status,
    400,
  );
  ready = await f.action(f.other, ready, "place", { date: "2020-01-01" });
  assert.equal(ready.placement.date, "2020-01-01");
  assert.equal(ready.placement.at, "2026-11-27T12:00:00.000Z");
  const d2 = await f.create();
  const placed = await f.action(f.other, d2, "place", { date: "2026-11-27" });
  assert.equal(placed.ready, null);
  assert(
    !f.store
      .state(f.store.user("worker-1"))
      .audit.some((e) => e.document_id === d2.id && e.type === "READY"),
  );
});
test("8: all privileged transitions and batch blocked for worker; chief can confirm own placement", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  for (const a of ["confirm", "reject", "place-confirm"])
    assert.equal(
      (
        await f.worker.request(`/documents/${d.id}/actions/${a}`, {
          version: d.version,
          reason: "Причина",
          date: "2026-11-27",
        })
      ).status,
      403,
    );
  const period = f.store.periodList()[0];
  assert.equal(
    (
      await f.worker.request("/batches/confirm", {
        periodId: period.id,
        categoryId: "ALL",
        items: [{ id: d.id, version: d.version }],
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.worker.request("/reviews", { periodId: period.id })).status,
    403,
  );
  let own = await f.create();
  own = await f.action(f.chief, own, "place-confirm", { date: "2026-11-27" });
  assert.equal(own.confirmation.userId, "chief-1");
  assert.equal(own.placement.userId, "chief-1");
});
test("9: rejection requires reason, clears effective placement and preserves history; retry works", async (t) => {
  const f = await fixture(t);
  let d = await f.create({ dueDate: "2026-11-20" });
  d = await f.action(f.worker, d, "place", { date: "2026-11-20" });
  assert.equal(
    (
      await f.chief.request(`/documents/${d.id}/actions/reject`, {
        version: d.version,
        reason: "  ",
      })
    ).status,
    400,
  );
  d = await f.action(f.chief, d, "reject", { reason: "Не хватает подписей" });
  assert.equal(d.placement, null);
  assert.equal(
    f.store.state(f.store.user("worker-1")).documents[0].deadline.kind,
    "overdue",
  );
  assert.equal(
    f.store
      .state(f.store.user("worker-1"))
      .audit.find((e) => e.type === "REJECT").data.before.placement.date,
    "2026-11-20",
  );
  d = await f.action(f.other, d, "place", { date: "2026-11-26" });
  d = await f.action(f.chief, d, "confirm");
  assert.equal(d.status, "CONFIRMED");
});
test("10,11: periods select by dueDate inclusively, regardless of creation/placement/status", async (t) => {
  const f = await fixture(t);
  for (const dueDate of [
    "2026-11-13",
    "2026-11-14",
    "2026-11-27",
    "2026-11-28",
  ])
    await f.create({ dueDate });
  const p = f.store.periodList()[0];
  assert.deepEqual(
    f.store.periodDocs(p).map((d) => d.dueDate),
    ["2026-11-14", "2026-11-27"],
  );
  assert.equal(
    f.store
      .state(f.store.user("worker-1"))
      .documents.find((d) => d.dueDate === "2026-11-27").deadline.label,
    "Срок сегодня",
  );
});
test("12,18: exact scoped batch, partial conflicts and operation ID per event; excludes omitted card", async (t) => {
  const f = await fixture(t);
  const p = f.store.periodList()[0];
  let selected = await f.create(),
    excluded = await f.create(),
    otherCat = await f.create({ categoryId: "category-2" }),
    otherPeriod = await f.create({ dueDate: "2026-11-13" }),
    stale = await f.create(),
    ready = await f.create();
  for (const n of [
    "selected",
    "excluded",
    "otherCat",
    "otherPeriod",
    "stale",
  ]) {
  }
  selected = await f.action(f.worker, selected, "place", {
    date: "2026-11-27",
  });
  excluded = await f.action(f.worker, excluded, "place", {
    date: "2026-11-27",
  });
  otherCat = await f.action(f.worker, otherCat, "place", {
    date: "2026-11-27",
  });
  otherPeriod = await f.action(f.worker, otherPeriod, "place", {
    date: "2026-11-27",
  });
  stale = await f.action(f.worker, stale, "place", { date: "2026-11-27" });
  await f.other.request(
    "/documents/" + stale.id,
    {
      version: stale.version,
      title: "Изменено",
      dueDate: stale.dueDate,
      categoryId: stale.categoryId,
    },
    "PATCH",
  );
  const b = {
    periodId: p.id,
    categoryId: "category-1",
    items: [selected, otherCat, otherPeriod, stale, ready].map((d) => ({
      id: d.id,
      version: d.version,
    })),
  };
  const r = await f.chief.request("/batches/confirm", b);
  assert.equal(r.status, 200);
  assert.deepEqual(
    [r.data.confirmed, r.data.skipped, r.data.conflicts],
    [1, 3, 1],
  );
  assert.equal(f.store.document(excluded.id).status, "PLACED");
  assert.equal(f.store.document(otherCat.id).status, "PLACED");
  assert.equal(
    f.store
      .state(f.store.user("worker-1"))
      .audit.find((e) => e.type === "CONFIRM").batch_id,
    r.data.id,
  );
});
test("13,16: review is independent of statuses; snapshot survives changes and soft deletion", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  const r = await f.chief.request("/reviews", {
    periodId: f.store.periodList()[0].id,
  });
  assert.equal(r.status, 200);
  assert.equal(f.store.document(d.id).status, "IN_PROGRESS");
  await f.other.request(
    "/documents/" + d.id,
    { version: d.version, confirmed: true },
    "DELETE",
  );
  const state = (await f.worker.request("/state")).data;
  assert.equal(state.documents[0].deleted, true);
  assert.equal(state.reviewRecords[0].snapshot.documents[0].deleted, false);
  assert.equal(state.reviewRecords[0].snapshot.documents[0].version, 1);
  assert(state.audit.some((e) => e.type === "DELETE"));
  assert.equal(
    (
      await f.worker.request(
        "/documents/" + d.id,
        {
          version: 2,
          title: "x",
          dueDate: d.dueDate,
          categoryId: d.categoryId,
        },
        "PATCH",
      )
    ).status,
    409,
  );
});
test("14: schedule mutation preview, old records and confirmations unchanged, stale config blocked", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  await f.chief.request("/reviews", { periodId: f.store.periodList()[0].id });
  const before = f.store.state(f.store.user("chief-1")).reviewRecords[0];
  const preview = await f.chief.request("/schedule/preview", {
    anchor: "2026-11-10",
    interval: 10,
  });
  assert.equal(preview.data.periods[0].start, "2026-11-28");
  assert.equal(preview.data.periods[0].end, "2026-11-30");
  const r = await f.chief.request("/schedule", {
    anchor: "2026-11-10",
    interval: 10,
    expectedVersion: "initial",
  });
  assert.equal(r.status, 200);
  assert.equal(f.store.document(d.id).status, "CONFIRMED");
  assert.deepEqual(
    f.store.state(f.store.user("chief-1")).reviewRecords[0],
    before,
  );
  assert.equal(
    (
      await f.chief.request("/schedule", {
        anchor: "2026-11-10",
        interval: 7,
        expectedVersion: "initial",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.other.request("/schedule", {
        anchor: "2026-11-10",
        interval: 7,
        expectedVersion: r.data.id,
      })
    ).status,
    403,
  );
});
test("15: identical edit leaves confirmation/version; changed significant field resets confirmation", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  const b = {
    version: d.version,
    title: d.title,
    dueDate: d.dueDate,
    categoryId: d.categoryId,
  };
  let r = await f.other.request("/documents/" + d.id, b, "PATCH");
  assert.equal(r.data.version, d.version);
  assert.equal(r.data.status, "CONFIRMED");
  r = await f.other.request(
    "/documents/" + d.id,
    { ...b, title: "Новая редакция" },
    "PATCH",
  );
  assert.equal(r.status, 400);
  r = await f.other.request(
    "/documents/" + d.id,
    { ...b, title: "Новая редакция", acknowledgeReset: true },
    "PATCH",
  );
  assert.equal(r.data.status, "PLACED");
  assert.equal(r.data.confirmation, null);
  assert(r.data.placement);
  assert(
    f.store
      .state(f.store.user("worker-1"))
      .audit.some((e) => e.data.confirmationReset),
  );
});
test("15: editing actual placement date resets confirmation with history", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  const r = await f.other.request(
    "/documents/" + d.id,
    {
      version: d.version,
      title: d.title,
      categoryId: d.categoryId,
      dueDate: d.dueDate,
      placementDate: "2026-11-26",
      acknowledgeReset: true,
    },
    "PATCH",
  );
  assert.equal(r.data.status, "PLACED");
  assert.equal(r.data.placement.date, "2026-11-26");
});
test("return and revoke require reasons, old marks remain in immutable audit", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  assert.equal(
    (
      await f.other.request(`/documents/${d.id}/actions/revoke`, {
        version: d.version,
        reason: "Ошибка",
      })
    ).status,
    403,
  );
  d = await f.action(f.chief, d, "revoke", { reason: "Нужно проверить" });
  assert.equal(d.status, "PLACED");
  d = await f.action(f.other, d, "return", {
    reason: "Ошибка отметки",
    confirmed: true,
  });
  assert.equal(d.status, "IN_PROGRESS");
  assert.equal(d.placement, null);
  assert.equal(d.ready, null);
  const e = f.store
    .state(f.store.user("worker-1"))
    .audit.find((e) => e.type === "RETURN");
  assert(e.data.before.placement);
});
test("17: copy via create has fresh identity, deadline, author and no old marks", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  const r = await f.other.request("/documents", {
    title: d.title,
    categoryId: d.categoryId,
    dueDate: "2026-12-04",
    status: "CONFIRMED",
    placement: d.placement,
  });
  assert.equal(r.data.status, "IN_PROGRESS");
  assert.equal(r.data.placement, null);
  assert.equal(r.data.createdBy.userId, "worker-2");
  assert.notEqual(r.data.id, d.id);
});
test("18: two simultaneous clients cannot overwrite; retry is idempotent and key cannot be repurposed", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  const b = {
    version: d.version,
    title: "Редакция",
    dueDate: d.dueDate,
    categoryId: d.categoryId,
  };
  const results = await Promise.all([
    f.worker.request("/documents/" + d.id, b, "PATCH"),
    f.other.request(
      "/documents/" + d.id,
      { ...b, title: "Другая редакция" },
      "PATCH",
    ),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const key = randomUUID(),
    createBody = {
      title: "Повтор",
      categoryId: "category-1",
      dueDate: "2026-11-27",
    };
  const r = await f.worker.request("/documents", createBody, "POST", key);
  const retry = await f.worker.request("/documents", createBody, "POST", key);
  assert.deepEqual(retry, r);
  assert.equal(f.store.documents().length, 2);
  assert.equal(
    f.store
      .state(f.store.user("worker-1"))
      .audit.filter((e) => e.document_id === r.data.id).length,
    1,
  );
  assert.equal(
    (
      await f.worker.request(
        "/documents",
        { ...createBody, title: "Подмена" },
        "POST",
        key,
      )
    ).status,
    409,
  );
});
test("18: stale individual confirmation fails after selected card is edited", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  await f.other.request(
    "/documents/" + d.id,
    {
      version: d.version,
      title: "Исправленная",
      categoryId: d.categoryId,
      dueDate: d.dueDate,
    },
    "PATCH",
  );
  assert.equal(
    (
      await f.chief.request(`/documents/${d.id}/actions/confirm`, {
        version: d.version,
      })
    ).status,
    409,
  );
  assert.equal(f.store.document(d.id).status, "PLACED");
});
test("19: disabled user loses existing session immediately, audit keeps original display name", async (t) => {
  const f = await fixture(t);
  await f.action(f.other, await f.create(), "ready");
  const r = await f.worker.request(
    "/users/worker-2",
    {
      name: "Новое имя",
      telegramId: "900000002",
      role: "WORKER",
      active: false,
    },
    "PATCH",
  );
  assert.equal(r.status, 200);
  assert.equal((await f.other.request("/state")).status, 401);
  assert.equal(
    f.store
      .state(f.store.user("worker-1"))
      .audit.find((e) => e.type === "READY").actor_name,
    "Иван Петров",
  );
});
test("19,20: admin transfer, documents and review snapshot persist across reopening database", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.sqlite");
  let f = createApp({
    database: path,
    demo: true,
    production: false,
    seed: false,
    clock: fixed,
  });
  const w = f.store.user("worker-1");
  let d = f.store.create(w, {
    title: "Сохранить",
    categoryId: "category-1",
    dueDate: "2026-11-27",
  });
  f.store.review(f.store.user("chief-1"), {
    periodId: f.store.periodList()[0].id,
  });
  f.store.mutate(w, randomUUID(), "transfer", {}, (a) =>
    f.store.transfer(a, { userId: "worker-2" }),
  );
  f.db.close();
  f = createApp({
    database: path,
    demo: true,
    production: false,
    seed: false,
    clock: fixed,
  });
  assert.equal(f.store.document(d.id).title, "Сохранить");
  assert.equal(f.store.user("worker-1").admin, false);
  assert.equal(f.store.user("worker-2").admin, true);
  assert.equal(f.store.state(f.store.user("worker-2")).reviewRecords.length, 1);
  assert.throws(() =>
    f.store.saveUser(f.store.user("worker-2"), "worker-2", {
      name: "x",
      telegramId: "900000002",
      role: "WORKER",
      active: false,
    }),
  );
  f.db.close();
});
test("admin and category permissions are independent from working role; category cannot hide unprocessed docs", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  assert.equal(
    (
      await f.chief.request("/users", {
        name: "x",
        telegramId: "555",
        role: "WORKER",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.worker.request(
        "/categories/category-1",
        { name: "Скрытая", position: 1, hidden: true },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.other.request("/categories", { name: "x", position: 4 })).status,
    403,
  );
  assert.equal(
    (
      await f.worker.request("/categories", {
        name: "Дополнительная",
        position: 4,
      })
    ).status,
    200,
  );
});
test("transaction rolls back mutation AND audit on a failing request", async (t) => {
  const f = await fixture(t);
  const actor = f.store.user("worker-1");
  const before = f.store.state(actor).audit.length;
  assert.throws(() =>
    f.store.mutate(actor, randomUUID(), "test", {}, (a) => {
      f.store.create(a, {
        title: "Откат",
        dueDate: "2026-11-27",
        categoryId: "category-1",
      });
      throw new Error("Fail");
    }),
  );
  assert.equal(f.store.documents().length, 0);
  assert.equal(f.store.state(actor).audit.length, before);
});
function signed(token, userId, at = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({
    auth_date: String(at),
    query_id: "test",
    signature: "signed-field",
    user: JSON.stringify({ id: userId, first_name: "Test" }),
  });
  const check = [...p]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
}
test("1: Telegram HMAC checks integrity, age, duplicate keys and future timestamp", () => {
  const token = "test-token";
  assert.equal(validateTelegram(signed(token, 123), token), "123");
  assert.throws(() =>
    validateTelegram(signed(token, 123) + "&auth_date=1", token),
  );
  assert.throws(() =>
    validateTelegram(signed(token, 123).replace("test", "fake"), token),
  );
  assert.throws(() => validateTelegram(signed(token, 123, 1), token));
  assert.throws(() =>
    validateTelegram(
      signed(token, 123, Math.floor(Date.now() / 1000) + 120),
      token,
    ),
  );
});
test("production fails closed: no demo auth, explicit bootstrap ID required, Telegram unknown blocked", async (t) => {
  assert.throws(() =>
    createApp({ production: true, demo: true, database: ":memory:" }),
  );
  assert.throws(() =>
    createApp({
      production: true,
      demo: false,
      database: ":memory:",
      botToken: "test",
      origin: "https://example.test",
    }),
  );
  const instance = createApp({
    production: true,
    demo: false,
    database: ":memory:",
    adminId: "123",
    botToken: "test",
    origin: "https://example.test",
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    instance.db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(base + "/auth/demo-users")).status, 404);
  assert.equal(
    (
      await fetch(base + "/auth/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "worker-1" }),
      })
    ).status,
    404,
  );
  const login = async (id) =>
    fetch(base + "/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: signed("test", id) }),
    });
  assert.equal((await login(999)).status, 403);
  const allowed = await login(123);
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get("set-cookie"), /Secure/);
  const { sessionToken } = await allowed.json();
  const state = await fetch(base + "/state", {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).me.telegram_id, "123");
  assert.equal((await fetch(base + "/state")).status, 401);
});

test("14: repeated pre-start replacements retain all versions while only latest sequence is active", async (t) => {
  const f = await fixture(t, { clock: () => new Date("2026-11-11T12:00:00Z") });
  const first = await f.worker.request("/schedule", {
    anchor: "2026-11-20",
    interval: 7,
    expectedVersion: "initial",
  });
  assert.equal(first.status, 200);
  assert.equal(f.store.periodList()[0].start, "2026-11-21");
  const second = await f.worker.request("/schedule", {
    anchor: "2026-11-13",
    interval: 10,
    expectedVersion: first.data.id,
  });
  assert.equal(second.status, 200);
  assert.equal(f.store.periodList()[0].start, "2026-11-14");
  assert.equal(f.store.periodList()[0].end, "2026-11-23");
  assert.equal(f.store.allVersions().length, 3);
  assert.equal(f.store.versions().length, 1);
  assert.equal(
    f.store.state(f.store.user("worker-1")).scheduleVersions.length,
    3,
  );
});

test("12: malformed batch items and hidden scope are rejected, retry does not duplicate confirmation", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  const b = {
    periodId: f.store.periodList()[0].id,
    categoryId: "ALL",
    items: [{ id: d.id, version: d.version }],
  };
  for (const items of [[null], [{ id: d.id }], [{ id: d.id, version: "2" }]])
    assert.equal(
      (await f.chief.request("/batches/confirm", { ...b, items })).status,
      400,
    );
  const key = randomUUID();
  const first = await f.chief.request("/batches/confirm", b, "POST", key);
  const retry = await f.chief.request("/batches/confirm", b, "POST", key);
  assert.deepEqual(retry, first);
  assert.equal(
    f.store
      .state(f.store.user("chief-1"))
      .audit.filter((e) => e.type === "CONFIRM").length,
    1,
  );
});

test("Telegram Web bearer sessions work without cookies and immediately enforce roles and access", async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.base + "/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "worker-2" }),
  });
  const { sessionToken } = await response.json();
  assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);
  const hashes = f.db.prepare("SELECT token_hash FROM sessions").all();
  assert(
    hashes.every(
      (r) => r.token_hash !== sessionToken && r.token_hash.length === 64,
    ),
  );
  const call = async (path, body) =>
    fetch(f.base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  assert.equal((await call("/state")).status, 200);
  let d = await f.create();
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  assert.equal(
    (
      await call(`/documents/${d.id}/actions/confirm`, {
        version: d.version,
        role: "CHIEF",
      })
    ).status,
    403,
  );
  f.store.saveUser(f.store.user("worker-1"), "worker-2", {
    name: "Иван Петров",
    telegramId: "900000002",
    role: "CHIEF",
    active: true,
  });
  assert.equal(
    (await call(`/documents/${d.id}/actions/confirm`, { version: d.version }))
      .status,
    200,
  );
  f.store.saveUser(f.store.user("worker-1"), "worker-2", {
    name: "Иван Петров",
    telegramId: "900000002",
    role: "CHIEF",
    active: false,
  });
  assert.equal((await call("/state")).status, 401);
});

test("bearer sessions reject invalid credentials, expire and are revoked on logout", async (t) => {
  const f = await fixture(t);
  async function login() {
    const r = await fetch(f.base + "/auth/demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "worker-2" }),
    });
    return (await r.json()).sessionToken;
  }
  for (const authorization of [
    "Bearer invalid",
    "Basic abc",
    "Bearer " + "a".repeat(43),
  ]) {
    const r = await fetch(f.base + "/state", {
      headers: { Authorization: authorization, Cookie: f.worker.cookie },
    });
    assert.equal(r.status, 401);
  }
  let token = await login();
  f.db.prepare("UPDATE sessions SET expires=0 WHERE user_id=?").run("worker-2");
  assert.equal(
    (
      await fetch(f.base + "/state", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  token = await login();
  const logout = await fetch(f.base + "/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (
      await fetch(f.base + "/state", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
});
