import { resolve } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { openDb } from "../server/db.mjs";
import { exportData } from "../server/portable-backup.mjs";
const source = resolve(
  process.argv[2] || process.env.DATABASE_PATH || "data/vpr.sqlite",
);
if (!existsSync(source)) throw new Error("Исходная база не найдена: " + source);
const destination = resolve(
  process.argv[3] || "backups/cloudflare-migration.json",
);
if (existsSync(destination))
  throw new Error("Файл уже существует. Выберите новое имя резервной копии.");
const { dirname } = await import("node:path");
mkdirSync(dirname(destination), { recursive: true });
const db = openDb(source);
try {
  writeFileSync(destination, JSON.stringify(exportData(db)), {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Сохранена копия: " + destination);
} finally {
  db.close();
}
