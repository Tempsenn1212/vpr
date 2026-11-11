import { addDays } from "./domain.mjs";
export function seedDemo(store) {
  if (store.db.prepare("SELECT value FROM meta WHERE key='demo_seeded'").get())
    return;
  const worker = store.user("worker-1"),
    other = store.user("worker-2"),
    chief = store.user("chief-1");
  const day = store.day();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const examples = [
      [
        "План воспитательной работы на неделю",
        "category-1",
        addDays(day, 2),
        "IN_PROGRESS",
      ],
      [
        "Журнал доведения служебной информации",
        "category-1",
        addDays(day, -3),
        "READY",
      ],
      ["Лист ознакомления с приказом", "category-1", "2026-11-27", "PLACED"],
      [
        "Отчёт о проведённых мероприятиях",
        "category-2",
        "2026-11-27",
        "PLACED",
      ],
      [
        "График индивидуальных бесед",
        "category-2",
        addDays(day, -7),
        "CONFIRMED",
      ],
      [
        "Сведения о выполнении плана",
        "category-3",
        addDays(day, -2),
        "NEEDS_CORRECTION",
      ],
      [
        "Архивная карточка для проверки истории",
        "category-3",
        addDays(day, -10),
        "DELETE",
      ],
    ];
    for (const [title, categoryId, dueDate, status] of examples) {
      let d = store.create(worker, { title, categoryId, dueDate });
      if (status === "READY")
        d = store.action(other, d.id, "ready", { version: d.version });
      if (["PLACED", "CONFIRMED", "NEEDS_CORRECTION"].includes(status)) {
        d = store.action(other, d.id, "place", {
          version: d.version,
          date: day,
        });
        if (status === "CONFIRMED")
          store.action(chief, d.id, "confirm", { version: d.version });
        if (status === "NEEDS_CORRECTION")
          store.action(chief, d.id, "reject", {
            version: d.version,
            reason: "Нужно проверить комплект подписей",
          });
      }
      if (status === "DELETE")
        store.remove(worker, d.id, { version: d.version, confirmed: true });
    }
    store.db.prepare("INSERT INTO meta VALUES('demo_seeded','true')").run();
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
}
