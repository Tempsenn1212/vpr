import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
const source = resolve(process.env.DATABASE_PATH || "data/vpr.sqlite");
const destination = resolve(
  process.argv[2] ||
    `backups/vpr-${new Date().toISOString().replaceAll(":", "-")}.sqlite`,
);
if (!existsSync(source)) throw new Error("Исходная база не найдена");
if (existsSync(destination) || source === destination)
  throw new Error("Укажите новый файл резервной копии");
mkdirSync(dirname(destination), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  await backup(db, destination);
  const check = new DatabaseSync(destination, { readOnly: true });
  try {
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Ошибка проверки резервной копии");
  } finally {
    check.close();
  }
  console.log(`Резервная копия создана и проверена: ${destination}`);
} finally {
  db.close();
}
