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
    automation: false,
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
    automation: false,
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
    automation: false,
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
test("worker placement completes work with no chief confirmation or period review", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.other, d, "place", { date: "2026-11-27" });
  const state = (await f.worker.request("/state")).data;
  const saved = state.documents.find((x) => x.id === d.id);
  assert.equal(saved.completed, true);
  assert.equal(saved.status, "PLACED");
  assert.equal(saved.confirmation, null);
  assert.equal(saved.placement.userId, "worker-2");
  assert.equal(state.reviewRecords.length, 0);
  assert.deepEqual(state.audit.map((e) => e.type).sort(), ["CREATE", "PLACE"]);
  const review = await f.chief.request("/reviews", {
    periodId: state.periods[0].id,
  });
  assert.equal(review.status, 200);
  assert.equal(review.data.snapshot.summary.completed, 1);
  assert.equal(review.data.snapshot.summary.unfinished, 0);
  assert.equal(f.store.document(d.id).status, "PLACED");
  assert.equal(
    (
      await f.worker.request(
        "/categories/category-1",
        {
          name: "Завершённая категория",
          position: 1,
          hidden: true,
        },
        "PATCH",
      )
    ).status,
    200,
  );
});
test("optional confirmation, reset and revocation preserve completion; reject and return reopen work", async (t) => {
  const f = await fixture(t);
  const completed = async (id) =>
    (await f.worker.request("/state")).data.documents.find((d) => d.id === id)
      .completed;
  let d = await f.create();
  assert.equal(await completed(d.id), false);
  d = await f.action(f.worker, d, "ready");
  assert.equal(await completed(d.id), false);
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  d = await f.action(f.chief, d, "confirm");
  assert.equal(await completed(d.id), true);
  d = await f.action(f.chief, d, "revoke", {
    reason: "Дополнительная проверка отменена",
  });
  assert.equal(await completed(d.id), true);
  d = await f.action(f.chief, d, "confirm");
  const edited = await f.worker.request(
    "/documents/" + d.id,
    {
      version: d.version,
      title: "Новое название",
      categoryId: d.categoryId,
      dueDate: d.dueDate,
      acknowledgeReset: true,
    },
    "PATCH",
  );
  assert.equal(edited.status, 200);
  d = edited.data;
  assert.equal(d.confirmation, null);
  assert.equal(await completed(d.id), true);
  d = await f.action(f.chief, d, "reject", {
    reason: "Вложения фактически нет",
  });
  assert.equal(await completed(d.id), false);
  assert.equal(d.placement, null);
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  assert.equal(await completed(d.id), true);
  await f.action(f.worker, d, "return", {
    reason: "Нужна доработка",
    confirmed: true,
  });
  assert.equal(await completed(d.id), false);
});
test("stored PLACED documents become complete after restart without rewriting data or history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-optional-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = {
    automation: false,
    database: join(dir, "existing.sqlite"),
    demo: true,
    production: false,
    seed: false,
    clock: fixed,
  };
  let instance = createApp(config);
  const worker = instance.store.user("worker-1");
  let d = instance.store.create(worker, {
    title: "Существующий документ",
    categoryId: "category-1",
    dueDate: "2026-11-27",
  });
  d = instance.store.action(worker, d.id, "place", {
    version: d.version,
    date: "2026-11-27",
  });
  const before = instance.db
    .prepare("SELECT data FROM documents WHERE id=?")
    .get(d.id).data;
  const audit = instance.store.state(worker).audit;
  instance.db.close();
  instance = createApp(config);
  try {
    const state = instance.store.state(instance.store.user(worker.id));
    assert.equal(state.documents[0].completed, true);
    assert.equal(state.documents[0].confirmation, null);
    assert.equal(state.reviewRecords.length, 0);
    assert.equal(
      instance.db.prepare("SELECT data FROM documents WHERE id=?").get(d.id)
        .data,
      before,
    );
    assert.deepEqual(state.audit, audit);
  } finally {
    instance.db.close();
  }
});
test("category names support full long titles through 300 characters", async (t) => {
  const f = await fixture(t);
  const category = f.store.categories().find((c) => c.id === "category-6");
  assert(category.name.length > 100);
  const saved = await f.worker.request(
    "/categories/category-6",
    {
      name: category.name,
      position: 6,
      hidden: false,
    },
    "PATCH",
  );
  assert.equal(saved.status, 200);
  assert.equal(
    f.store.categories().find((c) => c.id === category.id).name,
    category.name,
  );
  assert.equal(
    (
      await f.worker.request("/categories", {
        name: "Я".repeat(300),
        position: 12,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.worker.request("/categories", {
        name: "Я".repeat(301),
        position: 13,
      })
    ).status,
    400,
  );
});
test("recurrence API enforces roles, version conflicts, idempotency, protected topic and system identity", async (t) => {
  const f = await fixture(t, { automation: true });
  const rule = f.store.recurringRules().find((r) => r.id === "weekly-summary");
  const body = {
    version: rule.version,
    enabled: false,
    ready_day: 5,
    placement_day: 7,
  };
  assert.equal(
    (await f.other.request(`/recurring-rules/${rule.id}`, body, "PATCH"))
      .status,
    403,
  );
  const key = randomUUID();
  const saved = await f.worker.request(
    `/recurring-rules/${rule.id}`,
    body,
    "PATCH",
    key,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(
    await f.worker.request(`/recurring-rules/${rule.id}`, body, "PATCH", key),
    saved,
  );
  assert.equal(
    (await f.worker.request(`/recurring-rules/${rule.id}`, body, "PATCH"))
      .status,
    409,
  );
  assert.equal(
    (
      await f.worker.request(
        `/recurring-rules/${rule.id}`,
        { ...body, version: saved.data.version, ready_day: 8 },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.client().request("/auth/demo", { userId: "system-scheduler" }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.worker.request(
        "/users/system-scheduler",
        { name: "X", telegramId: "999", role: "CHIEF", active: true },
        "PATCH",
      )
    ).status,
    403,
  );
  const doc = f.store
    .documents()
    .find((d) => d.recurring?.ruleId === "inform-tuesday");
  assert.equal(
    (
      await f.worker.request(
        `/documents/${doc.id}`,
        {
          version: doc.version,
          title: doc.title,
          categoryId: doc.categoryId,
          dueDate: doc.dueDate,
          topic: "Другая тема",
        },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(f.store.document(doc.id).topic, doc.topic);
  assert.equal(
    (
      await f.worker.request("/documents", {
        title: "X",
        categoryId: "category-6",
        dueDate: "2026-11-30",
        topic: { bad: true },
      })
    ).status,
    400,
  );
});
test("forty nested items require real readiness before journal placement, with audit and optimistic conflicts", async (t) => {
  const f = await fixture(t);
  let d = await f.create({
    title: "Лист беседы",
    categoryId: "category-9",
    readyDueDate: "2026-11-27",
  });
  assert.equal(d.items.length, 40);
  assert.equal(
    (
      await f.worker.request(`/documents/${d.id}/actions/place`, {
        version: d.version,
        date: "2026-11-27",
      })
    ).status,
    400,
  );
  const originalVersion = d.version;
  for (const item of d.items) {
    const r = await f.other.request(
      `/documents/${d.id}/items/${item.id}`,
      { version: d.version, done: true },
      "PATCH",
    );
    assert.equal(r.status, 200);
    d = r.data;
  }
  assert.equal(d.status, "READY");
  assert.equal(d.ready.userId, "worker-2");
  assert.equal(
    (
      await f.worker.request(
        `/documents/${d.id}/items/item-1`,
        { version: originalVersion, done: false },
        "PATCH",
      )
    ).status,
    409,
  );
  const renamed = await f.worker.request(
    `/documents/${d.id}/items/item-1`,
    { version: d.version, label: "Рядовой Тестовый" },
    "PATCH",
  );
  assert.equal(renamed.status, 200);
  d = renamed.data;
  assert.equal(d.status, "IN_PROGRESS");
  assert.equal(d.items[0].ready, null);
  const ready = await f.worker.request(
    `/documents/${d.id}/items/item-1`,
    { version: d.version, done: true },
    "PATCH",
  );
  d = ready.data;
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  assert.equal(
    (
      await f.other.request(
        `/documents/${d.id}/items/item-1`,
        { version: d.version, done: false },
        "PATCH",
      )
    ).status,
    409,
  );
  const state = (await f.worker.request("/state")).data;
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].completed, true);
  assert.equal(state.audit.filter((e) => e.type === "SUBDOCUMENT").length, 42);
  d = await f.action(f.worker, d, "return", {
    reason: "Уточнить лист",
    confirmed: true,
  });
  const reopened = await f.other.request(
    `/documents/${d.id}/items/item-1`,
    { version: d.version, done: false },
    "PATCH",
  );
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.placement, null);
});
test("bulk readiness marks remaining conversation sheets once and preserves existing names and authors", async (t) => {
  const f = await fixture(t);
  let d = await f.create({ categoryId: "category-9", title: "Лист беседы" });
  d = (
    await f.other.request(
      `/documents/${d.id}/items/item-1`,
      { version: d.version, label: "Рядовой Тестовый", done: true },
      "PATCH",
    )
  ).data;
  const original = structuredClone(d);
  const path = `/documents/${d.id}/items/complete`,
    key = randomUUID(),
    body = { version: d.version };
  const r = await f.worker.request(path, body, "POST", key);
  assert.equal(r.status, 200);
  d = r.data;
  assert.equal(d.version, original.version + 1);
  assert.equal(d.status, "READY");
  assert.equal(d.ready.userId, "worker-1");
  assert.equal(d.placement, null);
  assert.deepEqual(d.items[0], original.items[0]);
  assert.deepEqual(
    d.items.map((i) => i.label),
    original.items.map((i) => i.label),
  );
  for (const item of d.items.slice(1))
    assert.deepEqual(item.ready, {
      userId: "worker-1",
      name: "Анна Смирнова",
      at: fixed().toISOString(),
    });
  let state = (await f.worker.request("/state")).data;
  assert.equal(state.documents[0].completed, false);
  const events = state.audit.filter((e) => e.type === "SUBDOCUMENTS");
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_id, "worker-1");
  assert.deepEqual(events[0].data.before, original);
  assert.deepEqual(events[0].data.after, d);
  assert.equal(events[0].data.markedCount, 39);
  assert.equal(events[0].data.total, 40);
  assert.deepEqual(
    events[0].data.itemIds,
    d.items.slice(1).map((i) => i.id),
  );
  assert.deepEqual(await f.worker.request(path, body, "POST", key), r);
  const noop = await f.other.request(path, { version: d.version });
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.data, d);
  state = (await f.worker.request("/state")).data;
  assert.equal(state.audit.filter((e) => e.type === "SUBDOCUMENTS").length, 1);
});
test("bulk conversation marks reject stale, deleted, completed and unrelated cards; return requires a fresh explicit mark", async (t) => {
  const f = await fixture(t);
  let d = await f.create({ categoryId: "category-9" });
  const originalVersion = d.version;
  d = (
    await f.other.request(
      `/documents/${d.id}/items/item-1`,
      { version: d.version, label: "Новое имя" },
      "PATCH",
    )
  ).data;
  const before = structuredClone(d);
  const path = `/documents/${d.id}/items/complete`;
  assert.equal(
    (await f.worker.request(path, { version: originalVersion })).status,
    409,
  );
  assert.deepEqual(f.store.document(d.id), before);
  assert.equal(
    (await f.client().request(path, { version: d.version })).status,
    401,
  );
  const plain = await f.create();
  assert.equal(
    (
      await f.worker.request(`/documents/${plain.id}/items/complete`, {
        version: plain.version,
      })
    ).status,
    400,
  );
  const deleted = await f.create({ categoryId: "category-9" });
  const removed = (
    await f.worker.request(
      `/documents/${deleted.id}`,
      { version: deleted.version, confirmed: true },
      "DELETE",
    )
  ).data;
  assert.equal(
    (
      await f.worker.request(`/documents/${deleted.id}/items/complete`, {
        version: removed.version,
      })
    ).status,
    409,
  );
  d = (await f.worker.request(path, { version: d.version })).data;
  d = await f.action(f.worker, d, "place", { date: "2026-11-27" });
  assert.equal(
    (await f.other.request(path, { version: d.version })).status,
    409,
  );
  d = await f.action(f.worker, d, "return", {
    confirmed: true,
    reason: "Пересмотреть группу",
  });
  assert.equal(d.status, "IN_PROGRESS");
  const marks = structuredClone(d.items);
  const ready = await f.chief.request(path, { version: d.version });
  assert.equal(ready.status, 200);
  assert.equal(ready.data.status, "READY");
  assert.equal(ready.data.ready.userId, "chief-1");
  assert.deepEqual(ready.data.items, marks);
  assert.equal(ready.data.placement, null);
});
test("bulk readiness rolls back all forty marks and audit on failure, then safely retries the same key", async (t) => {
  const f = await fixture(t);
  const d = await f.create({ categoryId: "category-9" });
  const path = `/documents/${d.id}/items/complete`,
    key = randomUUID(),
    body = { version: d.version };
  const before = f.db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
  f.db.exec(
    "CREATE TRIGGER fail_bulk BEFORE INSERT ON audit_events WHEN NEW.type='SUBDOCUMENTS' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  assert.equal((await f.worker.request(path, body, "POST", key)).status, 500);
  assert.deepEqual(f.store.document(d.id), d);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM audit_events ORDER BY seq").all(),
    before,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM request_keys WHERE key=?").get(key)
      .n,
    0,
  );
  f.db.exec("DROP TRIGGER fail_bulk");
  const retry = await f.worker.request(path, body, "POST", key);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.items.filter((i) => i.ready).length, 40);
  assert.equal(retry.data.version, d.version + 1);
  assert.deepEqual(await f.worker.request(path, body, "POST", key), retry);
  assert.equal(
    (await f.worker.request("/state")).data.audit.filter(
      (e) => e.type === "SUBDOCUMENTS",
    ).length,
    1,
  );
});
test("readiness deadline is independent from placement; invalid dates and group moves are rejected", async (t) => {
  const f = await fixture(t);
  let d = await f.create({ readyDueDate: "2026-11-25", dueDate: "2026-11-30" });
  let state = (await f.worker.request("/state")).data;
  assert.equal(state.documents[0].readyDeadline.kind, "overdue");
  assert.equal(state.documents[0].deadline.kind, "future");
  d = await f.action(f.worker, d, "ready");
  state = (await f.worker.request("/state")).data;
  assert.equal(state.documents[0].readyDeadline.kind, "late");
  assert.equal(state.documents[0].deadline.kind, "future");
  const historical = await f.create({
    readyDueDate: "2026-11-25",
    dueDate: "2026-11-30",
  });
  assert.equal(
    (
      await f.worker.request(`/documents/${historical.id}/actions/ready`, {
        version: historical.version,
        date: "2026-11-28",
      })
    ).status,
    400,
  );
  const marked = await f.action(f.worker, historical, "ready", {
    date: "2026-11-25",
  });
  assert.equal(marked.ready.at, "2026-11-27T12:00:00.000Z");
  state = (await f.worker.request("/state")).data;
  assert.equal(
    state.documents.find((x) => x.id === historical.id).readyDeadline.kind,
    "on-time",
  );
  assert.equal(
    (
      await f.worker.request(
        `/documents/${d.id}`,
        {
          version: d.version,
          title: d.title,
          categoryId: "category-9",
          dueDate: d.dueDate,
        },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.worker.request("/documents", {
        title: "X",
        categoryId: "category-1",
        dueDate: "2026-11-20",
        readyDueDate: "2026-11-21",
      })
    ).status,
    400,
  );
});
test("legacy confirmed cards without optional fields save unchanged without losing confirmation", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  delete d.readyDueDate;
  delete d.topic;
  delete d.items;
  delete d.recurring;
  f.store.write(d);
  const before = f.store.state(f.store.user("worker-1")).audit.length;
  const result = await f.worker.request(
    `/documents/${d.id}`,
    {
      version: d.version,
      title: d.title,
      categoryId: d.categoryId,
      dueDate: d.dueDate,
      readyDueDate: null,
      topic: "",
      acknowledgeReset: false,
    },
    "PATCH",
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, d);
  assert.equal(f.store.state(f.store.user("worker-1")).audit.length, before);
});
test("GDP report uses the same secure completion workflow with submission deadline wording", async (t) => {
  const f = await fixture(t, { automation: true });
  const report = f.store
    .documents()
    .find((d) => d.recurring?.ruleId === "weekly-gdp-report");
  assert.equal(report.dueDate, "2026-11-23");
  const saved = await f.action(f.other, report, "place", {
    date: "2026-11-23",
  });
  const state = (await f.worker.request("/state")).data;
  const doc = state.documents.find((d) => d.id === saved.id);
  assert.equal(doc.completed, true);
  assert.equal(doc.confirmation, null);
  assert.equal(doc.deadline.label, "Сдан в срок");
  assert.equal(doc.placement.userId, "worker-2");
  const manual = await f.create({
    title: "Рапорт ГДП",
    categoryId: "category-12",
    dueDate: "2026-11-20",
  });
  await f.action(f.worker, manual, "place", { date: "2026-11-21" });
  const late = (await f.worker.request("/state")).data.documents.find(
    (d) => d.id === manual.id,
  );
  assert.equal(late.deadline.label, "Сдан с опозданием на 1 дней");
});
test("comments retain the real author and timestamp without changing a confirmed document or review snapshot", async (t) => {
  const f = await fixture(t);
  let d = await f.create();
  d = await f.action(f.chief, d, "place-confirm", { date: "2026-11-27" });
  await f.chief.request("/reviews", { periodId: f.store.periodList()[0].id });
  const snapshots = f.db.prepare("SELECT * FROM review_records").all();
  const path = `/documents/${d.id}/comments`,
    key = randomUUID();
  const body = {
    text: "  Ожидает уточнения\nВторая строка  ",
    authorId: "chief-1",
    authorName: "Подмена",
    at: "2099-01-01T00:00:00Z",
    version: 1,
  };
  const response = await f.other.request(path, body, "POST", key);
  assert.equal(response.status, 200);
  const c = response.data;
  assert.equal(c.authorId, "worker-2");
  assert.equal(c.authorName, "Иван Петров");
  assert.equal(c.at, fixed().toISOString());
  assert.equal(c.text, "Ожидает уточнения\nВторая строка");
  assert.deepEqual(f.store.document(d.id), d);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM review_records").all(),
    snapshots,
  );
  assert.deepEqual(await f.other.request(path, body, "POST", key), response);
  for (const client of [f.worker, f.other, f.chief]) {
    const state = (await client.request("/state")).data;
    assert.deepEqual(state.comments, [c]);
    assert.equal(state.documents[0].status, "CONFIRMED");
    assert.equal(state.audit.filter((e) => e.type === "COMMENT").length, 1);
  }
  f.db.prepare("UPDATE users SET name='Новое имя' WHERE id='worker-2'").run();
  assert.equal(f.store.comments()[0].authorName, "Иван Петров");
});
test("concurrent comments both persist without staling a document edit, and copies have an empty discussion", async (t) => {
  const f = await fixture(t);
  const d = await f.create();
  const responses = await Promise.all([
    f.worker.request(`/documents/${d.id}/comments`, {
      text: "Первый участник",
    }),
    f.other.request(`/documents/${d.id}/comments`, { text: "Второй участник" }),
  ]);
  assert(responses.every((r) => r.status === 200));
  const comments = f.store.comments();
  assert.equal(comments.length, 2);
  assert(comments[0].seq < comments[1].seq);
  assert.deepEqual(
    new Set(comments.map((c) => c.authorId)),
    new Set(["worker-1", "worker-2"]),
  );
  assert.deepEqual(f.store.document(d.id), d);
  const edit = await f.worker.request(
    `/documents/${d.id}`,
    {
      version: d.version,
      title: "Изменён после обсуждения",
      categoryId: d.categoryId,
      dueDate: d.dueDate,
    },
    "PATCH",
  );
  assert.equal(edit.status, 200);
  assert.equal(edit.data.version, d.version + 1);
  const copy = await f.create({ title: d.title });
  assert.equal(
    f.store.comments().filter((c) => c.documentId === copy.id).length,
    0,
  );
  assert.equal(
    f.store.comments().filter((c) => c.documentId === d.id).length,
    2,
  );
});
test("comment validation and authentication reject empty, oversized, disabled and deleted submissions", async (t) => {
  const f = await fixture(t);
  const d = await f.create(),
    path = `/documents/${d.id}/comments`;
  assert.equal(
    (await f.client().request(path, { text: "Недоступно" })).status,
    401,
  );
  assert.equal(
    (
      await f.worker.request("/documents/missing/comments", {
        text: "Не найден",
      })
    ).status,
    404,
  );
  for (const body of [
    {},
    { text: " \n\t " },
    { text: [] },
    { text: 12 },
    { text: "я".repeat(2001) },
  ])
    assert.equal((await f.worker.request(path, body)).status, 400);
  assert.equal(f.store.comments().length, 0);
  const max = await f.worker.request(path, { text: "я".repeat(2000) });
  assert.equal(max.status, 200);
  const removed = await f.worker.request(
    `/documents/${d.id}`,
    { version: d.version, confirmed: true },
    "DELETE",
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (await f.worker.request(path, { text: "После удаления" })).status,
    409,
  );
  assert.equal(
    (await f.worker.request("/state")).data.comments[0].text.length,
    2000,
  );
  const other = await f.create();
  f.db.prepare("UPDATE users SET active=0 WHERE id='worker-2'").run();
  assert.equal(
    (
      await f.other.request(`/documents/${other.id}/comments`, {
        text: "Отключённый участник",
      })
    ).status,
    401,
  );
  assert.equal(f.store.comments().length, 1);
});
test("comment and audit are rolled back together and the same idempotency key can retry", async (t) => {
  const f = await fixture(t);
  const d = await f.create(),
    path = `/documents/${d.id}/comments`,
    key = randomUUID(),
    body = { text: "Надёжное сохранение" };
  f.db.exec(
    "CREATE TRIGGER fail_comment BEFORE INSERT ON audit_events WHEN NEW.type='COMMENT' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  const auditBefore = f.db
    .prepare("SELECT * FROM audit_events ORDER BY seq")
    .all();
  assert.equal((await f.worker.request(path, body, "POST", key)).status, 500);
  assert.equal(f.store.comments().length, 0);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM audit_events ORDER BY seq").all(),
    auditBefore,
  );
  assert.deepEqual(f.store.document(d.id), d);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM request_keys WHERE key=?").get(key)
      .n,
    0,
  );
  f.db.exec("DROP TRIGGER fail_comment");
  const result = await f.worker.request(path, body, "POST", key);
  assert.equal(result.status, 200);
  assert.deepEqual(await f.worker.request(path, body, "POST", key), result);
  assert.equal(f.store.comments().length, 1);
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
    createApp({
      automation: false,
      production: true,
      demo: true,
      database: ":memory:",
    }),
  );
  assert.throws(() =>
    createApp({
      automation: false,
      production: true,
      demo: false,
      database: ":memory:",
      botToken: "test",
      origin: "https://example.test",
    }),
  );
  const instance = createApp({
    automation: false,
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
