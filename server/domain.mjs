export const STATUS = {
  IN_PROGRESS: "В работе",
  READY: "Оформлен, ожидает вложения в журнал",
  PLACED: "Вложен в журнал, ожидает подтверждения",
  CONFIRMED: "Вложение подтверждено",
  NEEDS_CORRECTION: "Требует исправления",
};
export class Problem extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const demand = (condition, message, status = 400, details) => {
  if (!condition) throw new Problem(status, message, details);
};
export function text(value, label, max = 200) {
  demand(typeof value === "string", `${label}: укажите текст`);
  const s = value.trim();
  demand(s.length > 0 && s.length <= max, `${label}: от 1 до ${max} символов`);
  return s;
}
export function date(value) {
  demand(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
    "Укажите календарную дату",
  );
  const d = new Date(`${value}T00:00:00Z`);
  demand(
    !isNaN(+d) &&
      d.toISOString().slice(0, 10) === value &&
      value >= "1900-01-01" &&
      value <= "2200-12-31",
    "Недопустимая дата (1900–2200)",
  );
  return value;
}
export const addDays = (d, n) =>
  new Date(Date.parse(d + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
export const days = (a, b) =>
  Math.round(
    (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000,
  );
export function today(at = new Date(), zone = "Europe/Moscow") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
export function deadline(d, day) {
  if (d.placement) {
    const late = days(d.placement.date, d.dueDate);
    return {
      kind: late > 0 ? "late" : "on-time",
      days: Math.max(0, late),
      label: late > 0 ? `Вложен с опозданием на ${late} дней` : "Вложен в срок",
    };
  }
  const left = days(d.dueDate, day);
  return {
    kind: left < 0 ? "overdue" : left === 0 ? "today" : "future",
    days: Math.abs(left),
    label:
      left < 0
        ? `Просрочено на ${-left} дней`
        : left === 0
          ? "Срок сегодня"
          : `Осталось ${left} дней`,
  };
}
export function summary(docs) {
  return {
    total: docs.length,
    ...Object.fromEntries(
      Object.keys(STATUS).map((s) => [
        s,
        docs.filter((d) => d.status === s).length,
      ]),
    ),
  };
}
export function scheduleInput(b) {
  const anchor = date(b.anchor);
  demand(
    Number.isInteger(b.interval) && b.interval > 0 && b.interval <= 3660,
    "Интервал: целое число от 1 до 3660 дней",
  );
  return { anchor, interval: b.interval };
}
// Latest version at each effective boundary wins; all versions remain in audit.
export function periods(versions, through) {
  const unique = new Map();
  for (const v of versions) unique.set(v.effectiveStart, v);
  const list = [...unique.values()].sort((a, b) =>
    a.effectiveStart.localeCompare(b.effectiveStart),
  );
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    let start = v.effectiveStart;
    let end = addDays(
      v.anchor,
      Math.max(
        1,
        Math.floor(days(addDays(start, -1), v.anchor) / v.interval) + 1,
      ) * v.interval,
    );
    if (end < start) end = addDays(end, v.interval);
    const stop = list[i + 1]?.effectiveStart;
    while (start <= through && (!stop || start < stop)) {
      demand(
        out.length < 120000,
        "Слишком много периодов; измените дату начала",
      );
      out.push({
        id: `${v.id}:${start}`,
        start,
        end,
        reviewDate: end,
        scheduleId: v.id,
        transition: days(end, start) + 1 !== v.interval,
      });
      start = addDays(end, 1);
      end = addDays(end, v.interval);
    }
  }
  return out;
}
export function proposeSchedule(versions, b, day) {
  const settings = scheduleInput(b);
  const first = versions[0];
  if (day < first.effectiveStart)
    return { ...settings, effectiveStart: addDays(settings.anchor, 1) };
  const current = periods(versions, day).find(
    (p) => p.start <= day && p.end >= day,
  );
  demand(current, "Текущий период не найден");
  return { ...settings, effectiveStart: addDays(current.end, 1) };
}
export function transition(source, action, body, actor, at, day) {
  const d = structuredClone(source);
  const mark = { userId: actor.id, name: actor.name, at };
  const chief = () =>
    demand(actor.role === "CHIEF", "Доступно только начальнику", 403);
  const from = (states) =>
    demand(
      states.includes(d.status),
      "Действие недоступно в текущем статусе",
      409,
    );
  const placed = () => ({
    ...mark,
    date: (() => {
      const value = date(body.date);
      demand(value <= day, "Фактическая дата не может быть в будущем");
      return value;
    })(),
  });
  switch (action) {
    case "ready":
      from(["IN_PROGRESS", "NEEDS_CORRECTION"]);
      d.status = "READY";
      d.ready = mark;
      d.placement = null;
      d.confirmation = null;
      d.rejection = null;
      break;
    case "place":
      from(["IN_PROGRESS", "READY", "NEEDS_CORRECTION"]);
      d.status = "PLACED";
      d.placement = placed();
      d.confirmation = null;
      d.rejection = null;
      break;
    case "place-confirm":
      chief();
      from(["IN_PROGRESS", "READY", "NEEDS_CORRECTION"]);
      d.status = "CONFIRMED";
      d.placement = placed();
      d.confirmation = { ...mark, contentVersion: d.version + 1 };
      d.rejection = null;
      break;
    case "confirm":
      chief();
      from(["PLACED"]);
      d.status = "CONFIRMED";
      d.confirmation = { ...mark, contentVersion: d.version + 1 };
      break;
    case "reject":
      chief();
      from(["PLACED"]);
      d.status = "NEEDS_CORRECTION";
      d.rejection = { ...mark, reason: text(body.reason, "Причина", 1000) };
      d.placement = null;
      d.confirmation = null;
      break;
    case "return":
      demand(body.confirmed === true, "Подтвердите возврат");
      text(body.reason, "Причина", 1000);
      d.status = "IN_PROGRESS";
      d.ready = null;
      d.placement = null;
      d.confirmation = null;
      d.rejection = null;
      break;
    case "revoke":
      chief();
      from(["CONFIRMED"]);
      text(body.reason, "Причина", 1000);
      d.status = "PLACED";
      d.confirmation = null;
      break;
    default:
      throw new Problem(400, "Неизвестное действие");
  }
  return d;
}
