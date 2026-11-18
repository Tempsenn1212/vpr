import type { Doc } from "./types";

const names = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
export function monthLabel(month: string) {
  return `${names[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
export function shiftMonth(month: string, delta: number) {
  const index =
    Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}
export function inMonth(doc: Pick<Doc, "dueDate">, month: string) {
  return !month || doc.dueDate.slice(0, 7) === month;
}
export function monthOptions(
  documents: Doc[],
  current: string,
  selected: string,
) {
  const months = new Set([current, ...(selected ? [selected] : [])]);
  for (let i = -12; i <= 12; i++) {
    const month = shiftMonth(selected || current, i);
    if (month >= "1900-01" && month <= "2200-12") months.add(month);
  }
  for (const doc of documents)
    if (!doc.deleted) months.add(doc.dueDate.slice(0, 7));
  return [
    { id: "", name: "Все месяцы" },
    ...[...months]
      .sort()
      .reverse()
      .map((id) => ({ id, name: monthLabel(id) })),
  ];
}
