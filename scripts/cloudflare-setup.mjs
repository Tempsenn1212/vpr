import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { openDb, initDb } from "../server/db.mjs";
import { exportData, importData } from "../server/portable-backup.mjs";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
function run(args, input, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    encoding: "utf8",
    input,
    stdio:
      input !== undefined
        ? ["pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"]
        : capture
          ? ["inherit", "pipe", "pipe"]
          : "inherit",
  });
  if (result.status !== 0) {
    if (capture)
      process.stderr.write((result.stderr || "") + (result.stdout || ""));
    throw new Error(
      "Команда Cloudflare не завершена. Исправьте указанную выше причину и повторите запуск.",
    );
  }
  if (capture) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    return (result.stdout || "") + "\n" + (result.stderr || "");
  }
}
const statePath = resolve(".cloudflare-setup.json");
try {
  console.log(
    "Бесплатный запуск ВПР: Cloudflare Workers + SQLite Durable Object. Платный тариф не подключается.",
  );
  let state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  if (state.complete) {
    console.log(
      "Первоначальная настройка уже завершена. Для обновления используйте npm run cloudflare:deploy.\nАдрес: " +
        state.url,
    );
    process.exitCode = 0;
  } else {
    const adminId = (
      process.env.INITIAL_ADMIN_TELEGRAM_ID ||
      (await rl.question("Ваш числовой Telegram ID: "))
    ).trim();
    if (
      !/^[1-9]\d{0,15}$/.test(adminId) ||
      !Number.isSafeInteger(Number(adminId))
    )
      throw new Error("Нужен числовой Telegram ID.");
    const botToken = process.env.BOT_TOKEN;
    if (!botToken)
      throw new Error(
        "Добавьте BOT_TOKEN в локальный файл .env и повторите команду. Токен в чат отправлять не нужно.",
      );
    if (!state.decided) {
      const source = (
        await rl.question(
          `Путь к SQLite или JSON-копии для переноса [${process.env.DATABASE_PATH || "data/vpr.sqlite"}]. Введите НОВАЯ для пустой базы: `,
        )
      ).trim();
      if (source.toLocaleUpperCase("ru") === "НОВАЯ")
        state = { decided: true, adminId };
      else {
        const file = resolve(
          source || process.env.DATABASE_PATH || "data/vpr.sqlite",
        );
        if (!existsSync(file))
          throw new Error(
            "База не найдена: " +
              file +
              ". Укажите существующий файл; пустая база автоматически не создаётся.",
          );
        let snapshot;
        if (file.toLocaleLowerCase().endsWith(".json")) {
          snapshot = JSON.parse(readFileSync(file, "utf8"));
        } else {
          const db = openDb(file);
          try {
            let promoteDemoAdminId;
            if (
              db.prepare("SELECT value FROM meta WHERE key='demo'").get()
                ?.value === "true"
            ) {
              const answer = await rl.question(
                "Это демонстрационная база. Перенести ВСЕ документы и историю, отключив тестовые аккаунты и назначив ваш настоящий Telegram ID администратором? Введите ДА для переноса: ",
              );
              if (answer.trim().toLocaleUpperCase("ru") !== "ДА")
                throw new Error(
                  "Перенос отменён. Исходная база не изменена. Для пустой базы повторите команду и введите НОВАЯ.",
                );
              promoteDemoAdminId = adminId;
            }
            snapshot = exportData(db, { promoteDemoAdminId });
          } finally {
            db.close();
          }
        }
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 20 * 1024 * 1024)
          throw new Error(
            "Копия больше 20 МБ. Нужен поэтапный перенос; публикация не начата.",
          );
        // Validate the complete snapshot in a disposable database before publishing.
        const check = openDb(":memory:");
        try {
          initDb(check, { production: true, demo: false, adminId });
          importData(check, snapshot, adminId);
        } finally {
          check.close();
        }
        if (
          !snapshot.tables.users.some(
            (u) => u.telegram_id === adminId && u.admin === 1 && u.active === 1,
          )
        )
          throw new Error(
            "INITIAL_ADMIN_TELEGRAM_ID должен совпадать с активным администратором исходной базы.",
          );
        mkdirSync("backups", { recursive: true });
        const backup = resolve("backups/cloudflare-" + Date.now() + ".json");
        writeFileSync(backup, JSON.stringify(snapshot), {
          flag: "wx",
          mode: 0o600,
        });
        state = {
          decided: true,
          adminId,
          backup,
          importToken: randomBytes(32).toString("hex"),
        };
        console.log("Сохранена резервная копия: " + backup);
      }
      writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    }
    if (state.adminId !== adminId)
      throw new Error(
        "Настройка уже начата с другим Telegram ID. Проверьте INITIAL_ADMIN_TELEGRAM_ID.",
      );
    console.log(
      "Откроется страница Cloudflare. Войдите и разрешите Wrangler работать с вашим аккаунтом.",
    );
    rl.close();
    run(["login"]);
    const built = process.env.npm_execpath
      ? spawnSync(
          process.execPath,
          [process.env.npm_execpath, "run", "build"],
          { stdio: "inherit" },
        )
      : spawnSync("npm", ["run", "build"], { stdio: "inherit" });
    if (built.status !== 0) throw new Error("Сборка не завершена.");
    const output = run(["deploy"], undefined, true);
    const url =
      output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0] ||
      state.url;
    if (!url)
      throw new Error(
        "Не удалось определить адрес workers.dev. Проверьте включение поддомена в аккаунте Cloudflare.",
      );
    state.url = url;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    const secrets = {
      BOT_TOKEN: botToken,
      INITIAL_ADMIN_TELEGRAM_ID: adminId,
      ...(state.importToken ? { IMPORT_TOKEN: state.importToken } : {}),
    };
    run(["secret", "bulk"], JSON.stringify(secrets));
    let health;
    for (let i = 0; i < 12; i++) {
      try {
        const r = await fetch(url + "/api/health", {
          signal: AbortSignal.timeout(15000),
        });
        if (r.ok) {
          health = await r.json();
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!health?.ok)
      throw new Error(
        "Публикация прошла, но /api/health пока не отвечает. Повторите setup; исходная база и копия сохранены.",
      );
    if (state.backup) {
      const response = await fetch(url + "/api/admin/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Import-Token": state.importToken,
        },
        body: readFileSync(state.backup),
        signal: AbortSignal.timeout(60000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error("Перенос базы не завершён: " + result.error);
      console.log(
        "База перенесена. Существующие документы и история сохранены.",
      );
      // Once used, this endpoint also refuses any different backup on the server.
      run(["secret", "delete", "IMPORT_TOKEN"], "y\n");
      delete state.importToken;
    }
    state.complete = true;
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
    console.log(
      "\nГотово. Интерфейс и API: " +
        url +
        "\nУкажите этот URL в BotFather для кнопки меню и Mini App. Затем проверьте вход и документы с телефона при выключенном компьютере.",
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
