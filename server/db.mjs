import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  const migrations = [
    "001_initial.sql",
    "002_document_categories.sql",
    "003_recurring_documents.sql",
    "004_gdp_report.sql",
    "005_plan_titles.sql",
  ];
  for (const [index, file] of migrations.entries()) {
    if (db.prepare("PRAGMA user_version").get().user_version >= index + 1)
      continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have migrated while this one waited for the lock.
      if (db.prepare("PRAGMA user_version").get().user_version < index + 1)
        db.exec(
          readFileSync(
            new URL(`./migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  return db;
}
export const userRow = (r) =>
  r ? { ...r, admin: !!r.admin, active: !!r.active } : null;
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
    db.exec("BEGIN IMMEDIATE");
    try {
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
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
