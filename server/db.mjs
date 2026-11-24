import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
    "006_document_comments.sql",
    "007_editable_lecture_topics.sql",
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
export { initDb } from "./initialize.mjs";
export { userRow } from "./users.mjs";
