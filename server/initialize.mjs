import { randomUUID } from "node:crypto";
import { transaction } from "./transaction.mjs";
export function initDb(db, config) {
  const get = (k) =>
    db.prepare("SELECT value FROM meta WHERE key=?").get(k)?.value;
  const set = (k, v) =>
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(k, v);
  if (config.production && get("demo") === "true")
    throw new Error(
      "Production запрещён на синтетической БД. Укажите новую DATABASE_PATH.",
    );
  if (!get("initialized")) {
    transaction(db, () => {
      if (config.demo) {
        set("demo", "true");
        for (let i = 1; i <= 4; i++)
          db.prepare("INSERT INTO users VALUES(?,?,?,?,?,1)").run(
            `worker-${i}`,
            `90000000${i}`,
            ["Анна Смирнова", "Иван Петров", "Мария Орлова", "Алексей Волков"][
              i - 1
            ],
            "WORKER",
            i === 1 ? 1 : 0,
          );
        db.prepare("INSERT INTO users VALUES(?,?,?,?,0,1)").run(
          "chief-1",
          "900000005",
          "Елена Соколова",
          "CHIEF",
        );
      } else {
        if (
          !/^\d{1,16}$/.test(config.adminId || "") ||
          !Number.isSafeInteger(Number(config.adminId)) ||
          Number(config.adminId) <= 0
        )
          throw new Error(
            "Укажите INITIAL_ADMIN_TELEGRAM_ID перед первым запуском",
          );
        db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1)").run(
          randomUUID(),
          config.adminId,
          "Администратор",
          "WORKER",
        );
      }
      db.prepare(
        "INSERT INTO schedule_versions(id,effective_start,anchor,interval,at) VALUES(?,?,?,?,?)",
      ).run(
        "initial",
        "2026-11-14",
        "2026-11-13",
        14,
        new Date().toISOString(),
      );
      set("initialized", "true");
    });
  }
}
