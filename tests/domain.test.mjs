import { test } from "node:test";
import assert from "node:assert/strict";
import {
  today,
  deadline,
  periods,
  proposeSchedule,
  transition,
  date,
  readyDeadline,
} from "../server/domain.mjs";
const initial = [
  {
    id: "initial",
    anchor: "2026-11-13",
    effectiveStart: "2026-11-14",
    interval: 14,
  },
];
test("7: Moscow midnight changes date at 21:00 UTC", () => {
  assert.equal(today(new Date("2026-11-20T20:59:59Z")), "2026-11-20");
  assert.equal(today(new Date("2026-11-20T21:00:00Z")), "2026-11-21");
});
test("4,7: READY is overdue, actual placement controls deadline, not confirmation time", () => {
  assert.equal(
    deadline({ status: "READY", dueDate: "2026-11-20" }, "2026-11-21").kind,
    "overdue",
  );
  assert.equal(
    deadline({ dueDate: "2026-11-20" }, "2026-11-20").label,
    "Срок сегодня",
  );
  assert.equal(
    deadline(
      {
        dueDate: "2026-11-20",
        placement: { date: "2026-11-20" },
        confirmation: { at: "2026-11-27" },
      },
      "2026-11-27",
    ).kind,
    "on-time",
  );
  assert.equal(
    deadline(
      { dueDate: "2026-11-20", placement: { date: "2026-11-21" } },
      "2026-11-27",
    ).days,
    1,
  );
});
test("10: original periods have exact inclusive boundaries and no check on anchor", () => {
  const p = periods(initial, "2026-12-12");
  assert.deepEqual(
    p.slice(0, 2).map((x) => [x.start, x.end]),
    [
      ["2026-11-14", "2026-11-27"],
      ["2026-11-28", "2026-12-11"],
    ],
  );
  assert(!p.some((x) => x.end === "2026-11-13"));
});
test("14: schedule change uses transition with no gaps or overlaps", () => {
  const next = {
    ...proposeSchedule(
      initial,
      { anchor: "2026-11-10", interval: 10 },
      "2026-11-20",
    ),
    id: "next",
  };
  assert.equal(next.effectiveStart, "2026-11-28");
  const list = periods([...initial, next], "2027-02-01");
  assert.equal(list[1].end, "2026-11-30");
  assert.equal(list[1].transition, true);
  for (let i = 1; i < list.length; i++)
    assert.equal(
      Date.parse(list[i].start) - Date.parse(list[i - 1].end),
      86400000,
    );
});
test("14: before first period, settings replace initial sequence", () => {
  assert.deepEqual(
    proposeSchedule(
      initial,
      { anchor: "2026-11-20", interval: 7 },
      "2026-11-11",
    ),
    { anchor: "2026-11-20", interval: 7, effectiveStart: "2026-11-21" },
  );
});
test("dates validate calendar values and positive integer intervals", () => {
  for (const s of ["2026-02-30", "2026-2-03", "invalid", "1899-12-31"])
    assert.throws(() => date(s));
  for (const interval of [0, -1, 1.5, "14"])
    assert.throws(() =>
      proposeSchedule(
        initial,
        { anchor: "2026-11-13", interval },
        "2026-11-20",
      ),
    );
});
test("5: direct placement does not invent READY mark", () => {
  const d = transition(
    { status: "IN_PROGRESS", version: 1, ready: null },
    "place",
    { date: "2026-11-19" },
    { id: "w", name: "Работник", role: "WORKER" },
    "2026-11-20T12:00:00Z",
    "2026-11-20",
  );
  assert.equal(d.ready, null);
  assert.equal(d.status, "PLACED");
  assert.equal(d.placement.at, "2026-11-20T12:00:00Z");
});
test("category-specific readiness terms preserve independent deadlines and real marks", () => {
  for (const [categoryId, done, dueToday, overdue, dateWord] of [
    [
      "category-6",
      "Лекторий проведен",
      "Провести сегодня",
      "Проведение просрочено",
      "проведения",
    ],
    [
      "category-8",
      "Доведена",
      "Довести сегодня",
      "Доведение просрочено",
      "доведения",
    ],
    [
      "category-2",
      "Оформлен",
      "Оформить сегодня",
      "Оформление просрочено",
      "оформления",
    ],
  ]) {
    const source = {
      categoryId,
      status: "IN_PROGRESS",
      version: 1,
      readyDueDate: "2026-11-13",
      dueDate: "2026-11-14",
      ready: null,
      placement: null,
    };
    assert.equal(readyDeadline(source, "2026-11-13").label, dueToday);
    assert.match(
      readyDeadline(source, "2026-11-15").label,
      new RegExp(overdue),
    );
    const actor = {
      id: "worker",
      name: "Синтетический участник",
      role: "WORKER",
    };
    assert.throws(
      () =>
        transition(
          source,
          "ready",
          { date: "2026-11-16" },
          actor,
          "2026-11-15T12:00:00Z",
          "2026-11-15",
        ),
      new RegExp(`дата ${dateWord}`),
    );
    const ready = transition(
      source,
      "ready",
      { date: "2026-11-13" },
      actor,
      "2026-11-15T12:00:00Z",
      "2026-11-15",
    );
    assert.equal(ready.status, "READY");
    assert.equal(ready.ready.date, "2026-11-13");
    assert.equal(ready.placement, null);
    assert.equal(readyDeadline(ready, "2026-11-15").label, done + " в срок");
    assert.equal(deadline(ready, "2026-11-15").kind, "overdue");
    assert.equal(
      readyDeadline(
        { ...ready, ready: { ...ready.ready, date: "2026-11-14" } },
        "2026-11-15",
      ).label,
      done + " с опозданием на 1 дней",
    );
  }
});
