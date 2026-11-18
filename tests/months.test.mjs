import { test } from "node:test";
import assert from "node:assert/strict";
import { monthLabel, shiftMonth, monthOptions } from "../client/months.ts";
// The filter is also used in the application; actual marks and creation dates
// must not move an existing card to another month.
import { inMonth } from "../client/months.ts";

test("document month follows the submission deadline across year boundaries and actual marks", () => {
  const d = {
    dueDate: "2027-01-02",
    readyDueDate: "2026-12-26",
    createdAt: "2026-11-18T12:00:00Z",
    placement: { date: "2026-12-30" },
    recurring: { start: "2026-12-21", end: "2026-12-27" },
  };
  assert.equal(inMonth(d, "2027-01"), true);
  assert.equal(inMonth(d, "2026-12"), false);
  assert.equal(inMonth(d, "2026-11"), false);
  assert.equal(inMonth(d, ""), true);
  assert.equal(inMonth({ dueDate: "2028-02-29" }, "2028-02"), true);
});
test("month navigation handles December, January and leap-year February without day rollover", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2027-01", -1), "2026-12");
  assert.equal(shiftMonth("2028-03", -1), "2028-02");
  assert.equal(monthLabel("2026-11"), "Ноябрь 2026");
  assert.equal(monthLabel("2027-01"), "Январь 2027");
});
test("month choices include data, current and selected empty months without deleted-only periods or duplicates", () => {
  const docs = [
    { dueDate: "2020-02-29", deleted: false },
    { dueDate: "2020-02-10", deleted: false },
    { dueDate: "2018-03-01", deleted: true },
  ];
  const options = monthOptions(docs, "2026-11", "2027-01");
  assert.deepEqual(options[0], { id: "", name: "Все месяцы" });
  assert(options.some((o) => o.id === "2026-11"));
  assert(options.some((o) => o.id === "2027-01"));
  assert(options.some((o) => o.id === "2020-02"));
  assert(!options.some((o) => o.id === "2018-03"));
  assert.equal(new Set(options.map((o) => o.id)).size, options.length);
  assert.deepEqual(
    options.slice(1).map((o) => o.id),
    options
      .slice(1)
      .map((o) => o.id)
      .sort()
      .reverse(),
  );
  for (const edge of ["1900-01", "2200-12"])
    assert(
      monthOptions([], edge, edge)
        .slice(1)
        .every((o) => o.id >= "1900-01" && o.id <= "2200-12"),
    );
});
