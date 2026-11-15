import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createApp } from "../server/app.mjs";
import { occurrences } from "../server/recurrence.mjs";
import { startRecurringJobs } from "../server/recurring-jobs.mjs";

function fixture(t, options = {}) {
  let at = new Date("2026-11-15T12:00:00Z");
  const app = createApp({
    database: ":memory:",
    demo: true,
    production: false,
    seed: false,
    automation: false,
    clock: () => at,
    ...options,
  });
  t.after(() => app.db.close());
  return {
    ...app,
    advance: (iso) => {
      at = new Date(iso);
    },
  };
}
test("calendar recurrence respects separate weekly deadlines, following Saturday and monthly placement of lectures", (t) => {
  const { store } = fixture(t);
  const get = (id, day) =>
    occurrences(
      store.recurringRules().find((r) => r.id === id),
      day,
      day,
    )[0];
  assert.deepEqual(
    [
      get("weekly-summary", "2026-11-15").readyDueDate,
      get("weekly-summary", "2026-11-15").dueDate,
    ],
    ["2026-11-13", "2026-11-15"],
  );
  for (const [day, expected] of [
    ["2026-11-15", "2026-11-09"],
    ["2026-11-16", "2026-11-16"],
    ["2027-01-04", "2027-01-04"],
  ]) {
    assert.equal(get("weekly-gdp-report", day).readyDueDate, expected);
    assert.equal(get("weekly-gdp-report", day).dueDate, expected);
  }
  assert.deepEqual(
    [
      get("weekly-battle", "2026-11-15").readyDueDate,
      get("weekly-battle", "2026-11-15").dueDate,
    ],
    ["2026-11-14", "2026-11-21"],
  );
  assert.deepEqual(
    [
      get("inform-tuesday", "2026-11-30").readyDueDate,
      get("inform-tuesday", "2026-11-30").dueDate,
    ],
    ["2026-12-01", "2026-12-31"],
  );
  assert.deepEqual(
    [
      get("weekly-summary", "2026-12-31").readyDueDate,
      get("weekly-summary", "2026-12-31").dueDate,
    ],
    ["2027-01-01", "2027-01-03"],
  );
});
test("calendar recurrence clamps month ends, uses calendar quarters, and generates callups only in July and December", (t) => {
  const { store } = fixture(t);
  const rule = (id) => store.recurringRules().find((r) => r.id === id);
  const one = (id, day) => occurrences(rule(id), day, day)[0];
  assert.equal(one("monthly-vpr", "2028-02-01").dueDate, "2028-02-29");
  assert.equal(one("monthly-vpr", "2027-02-01").dueDate, "2027-02-28");
  assert.equal(one("monthly-vpr", "2027-02-01").readyDueDate, "2027-02-25");
  for (const [day, due] of [
    ["2027-02-15", "2027-03-31"],
    ["2027-04-01", "2027-06-30"],
    ["2026-12-31", "2026-12-31"],
    ["2027-01-01", "2027-03-31"],
  ])
    assert.equal(one("quarterly-meeting", day).dueDate, due);
  assert.equal(
    occurrences(rule("callup-files"), "2026-11-01", "2026-11-30").length,
    0,
  );
  assert.deepEqual(
    occurrences(rule("callup-files"), "2026-07-15", "2027-01-01").map(
      (o) => o.dueDate,
    ),
    ["2026-07-31", "2026-12-31"],
  );
});
test("initial synchronization creates current periods once, four category-six types and one nested group of forty", (t) => {
  const { store } = fixture(t);
  assert.equal(store.syncRecurring(), 10);
  const docs = store.documents();
  assert.equal(docs.filter((d) => d.categoryId === "category-6").length, 4);
  assert.equal(docs.filter((d) => d.categoryId === "category-9").length, 1);
  assert.equal(
    docs.find((d) => d.categoryId === "category-9").items.length,
    40,
  );
  assert(
    docs.every(
      (d) =>
        d.status === "IN_PROGRESS" &&
        !d.ready &&
        !d.placement &&
        !d.confirmation,
    ),
  );
  assert(
    docs.every(
      (d) =>
        !["category-2", "category-3", "category-7", "category-8"].includes(
          d.categoryId,
        ),
    ),
  );
  const topic = docs.find((d) => d.recurring.ruleId === "inform-tuesday").topic;
  assert(
    topic.startsWith(
      "Военно-политическая (общественно-политическая) обстановка",
    ),
  );
  assert(topic.endsWith("в системе национальной безопасности."));
  assert.equal(store.users().length, 5);
  assert.equal(store.syncRecurring(), 0);
  assert.equal(store.state(store.user("worker-1")).audit.length, 10);
});
test("downtime catchup generates missed periods once and preserves soft-deleted occurrences", (t) => {
  const f = fixture(t);
  f.store.syncRecurring();
  const group = f.store.documents().find((d) => d.categoryId === "category-9");
  f.store.remove(f.store.user("worker-1"), group.id, {
    version: group.version,
    confirmed: true,
  });
  f.advance("2026-12-16T12:00:00Z");
  assert.equal(f.store.syncRecurring(), 34);
  assert.equal(f.store.documents().length, 44);
  assert.equal(
    f.store
      .documents()
      .filter((d) => d.recurring.ruleId === "monthly-conversations").length,
    2,
  );
  assert.equal(f.store.document(group.id).deleted, true);
  assert.equal(f.store.syncRecurring(), 0);
});
test("Moscow midnight starts a new month and persisted restart does not duplicate cards or audit", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-recurring-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let at = new Date("2026-11-30T20:59:59Z");
  const options = {
    database: join(dir, "db.sqlite"),
    demo: true,
    production: false,
    seed: false,
    clock: () => at,
  };
  let instance = createApp(options);
  const initial = instance.store.documents().length;
  at = new Date("2026-11-30T21:00:00Z");
  assert.equal(instance.store.syncRecurring(), 4);
  const ids = instance.store.documents().map((d) => d.id);
  const audit = instance.store.state(instance.store.user("worker-1")).audit;
  assert.equal(ids.length, initial + 4);
  instance.db.close();
  instance = createApp(options);
  try {
    assert.deepEqual(
      instance.store.documents().map((d) => d.id),
      ids,
    );
    assert.deepEqual(
      instance.store.state(instance.store.user("worker-1")).audit,
      audit,
    );
  } finally {
    instance.db.close();
  }
});
test("a failed generation rolls back cards, occurrence keys, audit and checkpoint together", (t) => {
  const { store, db } = fixture(t);
  const create = store.create.bind(store);
  let count = 0;
  store.create = (...args) => {
    if (++count === 3) throw new Error("Synthetic failure");
    return create(...args);
  };
  assert.throws(() => store.syncRecurring(), /Synthetic failure/);
  assert.equal(store.documents().length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM recurring_occurrences").get().n,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events").get().n, 0);
  assert.equal(
    db.prepare("SELECT value FROM meta WHERE key='recurring_last_sync'").get(),
    undefined,
  );
  store.create = create;
  assert.equal(store.syncRecurring(), 10);
});
test("background scheduler creates cards without an open browser and stops cleanly", async (t) => {
  const f = fixture(t);
  const errors = [];
  const stop = startRecurringJobs(f.store, {
    intervalMs: 10,
    onError: (e) => errors.push(e),
  });
  try {
    for (let i = 0; i < 20 && !f.store.documents().length; i++) await pause(10);
    assert.equal(f.store.documents().length, 10);
  } finally {
    stop();
  }
  f.advance("2026-12-01T12:00:00Z");
  await pause(30);
  assert.equal(f.store.documents().length, 10);
  assert.deepEqual(errors, []);
});
test("rule edits affect future cards; disabled or hidden rules do not generate cards", (t) => {
  const f = fixture(t);
  const actor = f.store.user("worker-1");
  f.store.saveCategory(actor, "category-6", {
    name: "Информирование",
    position: 6,
    hidden: true,
  });
  assert.equal(f.store.syncRecurring(), 6);
  const rule = f.store.recurringRules().find((r) => r.id === "monthly-vpr");
  const old = f.store.documents().find((d) => d.recurring.ruleId === rule.id);
  f.store.saveRecurringRule(actor, rule.id, {
    version: rule.version,
    enabled: true,
    ready_day: 20,
    placement_day: 31,
  });
  f.advance("2026-12-01T12:00:00Z");
  f.store.syncRecurring();
  assert.equal(f.store.document(old.id).readyDueDate, "2026-11-25");
  assert.equal(
    f.store
      .documents()
      .find(
        (d) =>
          d.recurring.ruleId === rule.id &&
          d.recurring.periodKey === "2026-12-01",
      ).readyDueDate,
    "2026-12-20",
  );
  const next = f.store.recurringRules().find((r) => r.id === rule.id);
  f.store.saveRecurringRule(actor, rule.id, {
    version: next.version,
    enabled: false,
    ready_day: 20,
    placement_day: 31,
  });
  f.advance("2027-01-01T12:00:00Z");
  f.store.syncRecurring();
  assert(
    !f.store
      .documents()
      .some(
        (d) =>
          d.recurring.ruleId === rule.id &&
          d.recurring.periodKey === "2027-01-01",
      ),
  );
});
