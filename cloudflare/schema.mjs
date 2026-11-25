import m1 from "../server/migrations/001_initial.sql";
import m2 from "../server/migrations/002_document_categories.sql";
import m3 from "../server/migrations/003_recurring_documents.sql";
import m4 from "../server/migrations/004_gdp_report.sql";
import m5 from "../server/migrations/005_plan_titles.sql";
import m6 from "../server/migrations/006_document_comments.sql";
import m7 from "../server/migrations/007_editable_lecture_topics.sql";
import m8 from "../server/migrations/008_custom_roles.sql";
export const migrations = [m1, m2, m3, m4, m5, m6, m7, m8];
export function migrate(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _vpr_schema (version INTEGER PRIMARY KEY)",
  );
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1;
    if (db.prepare("SELECT 1 FROM _vpr_schema WHERE version=?").get(version))
      continue;
    db.transaction(() => {
      // Durable Objects omit PRAGMA user_version and TEMP tables. Migration 5
      // drops its staging tables in this same atomic transaction.
      db.exec(
        sql
          .replace(/PRAGMA\s+user_version\s*=\s*\d+\s*;/gi, "")
          .replace(/CREATE TEMP TABLE /g, "CREATE TABLE "),
      );
      db.prepare("INSERT INTO _vpr_schema VALUES(?)").run(version);
    });
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS _vpr_auth_rate (ip TEXT PRIMARY KEY, at INTEGER NOT NULL, count INTEGER NOT NULL)",
  );
}
