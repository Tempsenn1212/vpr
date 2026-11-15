import { addDays, date } from "./domain.mjs";

export const SYSTEM_ACTOR_ID = "system-scheduler";
export const monthStart = (day) => day.slice(0, 7) + "-01";
export function monthEnd(day) {
  const start = monthStart(day);
  return addDays(addDays(start, 32).slice(0, 7) + "-01", -1);
}
export function monday(day) {
  const weekday = new Date(day + "T12:00:00Z").getUTCDay();
  return addDays(day, -(weekday === 0 ? 6 : weekday - 1));
}
function monthDay(start, n) {
  return (
    start.slice(0, 7) +
    "-" +
    String(Math.min(n, Number(monthEnd(start).slice(8)))).padStart(2, "0")
  );
}
function quarterStart(day) {
  const month = Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1;
  return `${day.slice(0, 4)}-${String(month).padStart(2, "0")}-01`;
}
export function occurrences(rule, from, through) {
  date(from);
  date(through);
  if (from > through) return [];
  let start =
    rule.cadence === "weekly"
      ? monday(from)
      : rule.cadence === "quarterly"
        ? quarterStart(from)
        : monthStart(from);
  const result = [];
  while (start <= through) {
    let end, readyDueDate, dueDate, next;
    if (rule.cadence === "weekly") {
      end = addDays(start, 6);
      readyDueDate = addDays(start, rule.ready_day - 1);
      dueDate =
        rule.placement_day === 0
          ? monthEnd(readyDueDate)
          : addDays(start, rule.placement_day - 1);
      next = addDays(start, 7);
    } else {
      const finalMonth =
        rule.cadence === "quarterly"
          ? addDays(start, 70).slice(0, 7) + "-01"
          : start;
      end = monthEnd(finalMonth);
      readyDueDate = monthDay(finalMonth, rule.ready_day);
      dueDate = monthDay(finalMonth, rule.placement_day);
      next = addDays(end, 1);
    }
    if (rule.cadence !== "callup" || ["07", "12"].includes(start.slice(5, 7))) {
      const label =
        rule.cadence === "weekly"
          ? `${start} — ${end}`
          : rule.cadence === "quarterly"
            ? `${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1} квартал ${start.slice(0, 4)}`
            : new Date(start + "T12:00:00Z").toLocaleDateString("ru-RU", {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              });
      result.push({ key: start, start, end, readyDueDate, dueDate, label });
    }
    start = next;
    if (result.length > 10000)
      throw new Error("Слишком большой интервал автоматического учёта");
  }
  return result;
}
