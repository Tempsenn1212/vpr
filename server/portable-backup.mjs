import { createHash, randomUUID } from "node:crypto";
import { defaultRoles, permissionCatalog } from "../shared/permissions.ts";
import { demand } from "./domain.mjs";
import { transaction } from "./transaction.mjs";
// Sessions are intentionally excluded: Telegram re-authenticates after migration.
export const backupTables = [
  "meta",
  "roles",
  "users",
  "user_roles",
  "categories",
  "documents",
  "audit_events",
  "schedule_versions",
  "review_periods",
  "review_records",
  "batch_operations",
  "request_keys",
  "recurring_rules",
  "recurring_occurrences",
  "document_comments",
];
export function exportData(db, { promoteDemoAdminId } = {}) {
  return transaction(db, () => {
    const demo =
      db.prepare("SELECT value FROM meta WHERE key='demo'").get()?.value ===
      "true";
    demand(
      !demo || promoteDemoAdminId,
      "Демонстрационную базу нельзя переносить без явного подтверждения и настоящего Telegram ID",
    );
    if (demo)
      demand(
        /^[1-9]\d{0,15}$/.test(promoteDemoAdminId) &&
          Number.isSafeInteger(Number(promoteDemoAdminId)) &&
          ![
            "900000001",
            "900000002",
            "900000003",
            "900000004",
            "900000005",
          ].includes(promoteDemoAdminId),
        "Нужен настоящий Telegram ID администратора, не тестовый ID",
      );
    const snapshot = {
      format: "vpr-portable-v1",
      schemaVersion: 8,
      exportedAt: new Date().toISOString(),
      tables: Object.fromEntries(
        backupTables.map((t) => [
          t,
          db
            .prepare(`SELECT * FROM ${t}`)
            .all()
            .filter(
              (row) => t !== "meta" || !row.key.startsWith("cloudflare_"),
            ),
        ]),
      ),
    };
    if (demo) {
      // Promote a COPY only. Keep historical authors, disable access for all other
      // identities, and make the explicitly chosen real account the sole admin.
      snapshot.tables.meta = snapshot.tables.meta.map((r) =>
        r.key === "demo" ? { ...r, value: "false" } : r,
      );
      let chosen = false;
      snapshot.tables.users = snapshot.tables.users.map((u) => {
        const real = u.telegram_id === promoteDemoAdminId;
        chosen ||= real;
        return { ...u, active: real ? 1 : 0, admin: real ? 1 : 0 };
      });
      if (!chosen)
        snapshot.tables.users.push({
          id: randomUUID(),
          telegram_id: promoteDemoAdminId,
          name: "Администратор",
          role: "WORKER",
          admin: 1,
          active: 1,
        });
      snapshot.promotedFromDemo = true;
    }
    return snapshot;
  });
}
export function importData(db, snapshot, adminTelegramId) {
  demand(
    snapshot?.format === "vpr-portable-v1" &&
      [7, 8].includes(snapshot.schemaVersion),
    "Неподдерживаемая версия резервной копии",
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  const expectedTables =
    snapshot.schemaVersion === 7
      ? backupTables.filter((t) => t !== "roles" && t !== "user_roles")
      : backupTables;
  demand(
    snapshot.tables &&
      expectedTables.every((t) => Array.isArray(snapshot.tables[t])) &&
      Object.keys(snapshot.tables).length === expectedTables.length,
    "Неполная резервная копия",
  );
  demand(
    !snapshot.tables.meta.some((r) => r.key === "demo" && r.value === "true"),
    "Демонстрационную базу нельзя переносить в рабочее приложение",
  );
  demand(
    snapshot.tables.meta.some(
      (r) => r.key === "initialized" && r.value === "true",
    ),
    "База не инициализирована",
  );
  demand(
    snapshot.tables.users.some(
      (u) =>
        u.telegram_id === adminTelegramId && u.admin === 1 && u.active === 1,
    ),
    "Ваш Telegram ID должен принадлежать активному администратору исходной базы",
  );
  if (snapshot.schemaVersion === 7)
    snapshot = {
      ...snapshot,
      schemaVersion: 8,
      tables: {
        ...snapshot.tables,
        roles: defaultRoles.map((r) => ({
          ...r,
          permissions: JSON.stringify(r.permissions),
        })),
        user_roles: [],
      },
    };
  demand(
    defaultRoles.every((r) => snapshot.tables.roles.some((x) => x.id === r.id)),
    "В копии отсутствуют исходные роли",
  );
  for (const role of snapshot.tables.roles) {
    let permissions;
    try {
      permissions = JSON.parse(role.permissions);
    } catch {}
    demand(
      typeof role.name === "string" &&
        role.name.trim().length > 0 &&
        role.name.length <= 80 &&
        Array.isArray(permissions) &&
        permissions.every((p) => permissionCatalog.some((x) => x.id === p)),
      "Некорректная роль в резервной копии",
    );
  }
  const marker = db
    .prepare("SELECT value FROM meta WHERE key='cloudflare_imported'")
    .get();
  if (marker) {
    demand(
      marker.value === fingerprint,
      "База уже перенесена. Повторная замена запрещена.",
      409,
    );
    return { ok: true, alreadyImported: true };
  }
  demand(
    !db.prepare("SELECT 1 FROM documents LIMIT 1").get() &&
      !db.prepare("SELECT 1 FROM audit_events LIMIT 1").get(),
    "Целевая база уже содержит данные. Автоматическая замена запрещена.",
    409,
  );
  const columns = Object.fromEntries(
    backupTables.map((t) => [
      t,
      db
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((r) => r.name),
    ]),
  );
  for (const t of backupTables)
    for (const row of snapshot.tables[t])
      demand(
        row &&
          Object.keys(row).length === columns[t].length &&
          columns[t].every(
            (c) =>
              Object.hasOwn(row, c) &&
              (row[c] === null ||
                typeof row[c] === "string" ||
                typeof row[c] === "number"),
          ),
        "Неверная структура таблицы " + t,
      );
  return transaction(db, () => {
    db.prepare("DELETE FROM sessions").run();
    for (const t of [...backupTables].reverse())
      db.prepare(`DELETE FROM ${t}`).run();
    for (const t of backupTables) {
      const cols = columns[t];
      const insert = db.prepare(
        `INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      );
      for (const row of snapshot.tables[t])
        insert.run(...cols.map((c) => row[c]));
    }
    db.prepare("INSERT INTO meta VALUES('cloudflare_imported',?)").run(
      fingerprint,
    );
    return {
      ok: true,
      documents: snapshot.tables.documents.length,
      users: snapshot.tables.users.length,
    };
  });
}
