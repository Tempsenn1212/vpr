import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import ts from "typescript";
import { openDb, initDb } from "../../server/db.mjs";
import { Store } from "../../server/store.mjs";
import { exportData } from "../../server/portable-backup.mjs";
const root = resolve("."),
  temp = mkdtempSync(join(tmpdir(), "vpr-cf-"));
const token = "12345:cloudflare-synthetic-test-token",
  adminId = "900001234";
let child,
  url,
  session,
  log = "",
  importUrl,
  importChild;
const children = [];
const sign = (id = adminId) => {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(id) }),
  });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...p]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => k + "=" + v)
          .join("\n"),
      )
      .digest("hex"),
  );
  return p.toString();
};
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function start(name, extra = {}) {
  const port = await freePort(),
    inspector = await freePort();
  const config = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync("wrangler.jsonc", "utf8"),
  ).config;
  config.name = "vpr-" + name;
  config.main = resolve("cloudflare/worker.mjs");
  config.assets.directory = resolve("dist");
  config.vars = {
    ...config.vars,
    BOT_TOKEN: token,
    INITIAL_ADMIN_TELEGRAM_ID: adminId,
    ...extra,
  };
  const path = join(temp, name + ".json");
  writeFileSync(path, JSON.stringify(config));
  const p = spawn(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--config",
      path,
      "--local",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--test-scheduled",
      "--persist-to",
      join(temp, name + "-state"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(temp, "config"),
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(p);
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  const origin = "http://127.0.0.1:" + port;
  for (let i = 0; i < 150; i++) {
    if (p.exitCode !== null)
      throw new Error("Wrangler exited " + p.exitCode + "\n" + log);
    try {
      const r = await fetch(origin + "/api/health");
      if (r.ok) return { p, url: origin };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Wrangler failed to start\n" + log.slice(-18000));
}
async function call(
  path,
  {
    method = "GET",
    data,
    auth = session,
    key = randomUUID(),
    origin = url,
    headers = {},
  } = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(auth ? { Authorization: "Bearer " + auth } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: await response.json(), response };
}
async function login(id = adminId, origin = url) {
  const r = await call("/api/auth/telegram", {
    method: "POST",
    data: { initData: sign(id) },
    auth: null,
    origin,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.sessionToken;
}
before(async () => {
  const app = await start("main");
  child = app.p;
  url = app.url;
  session = await login();
});
after(async () => {
  for (const p of children) {
    if (p.exitCode === null) {
      p.kill("SIGTERM");
      await new Promise((r) => {
        p.once("exit", r);
        setTimeout(() => {
          p.kill("SIGKILL");
          r();
        }, 5000).unref();
      });
    }
  }
  if (process.env.VPR_CF_LOG) console.log(log);
  rmSync(temp, { recursive: true, force: true });
});
test("Cloudflare serves UI/API together and signed Telegram auth, no demo, origin and role checks", async () => {
  const page = await fetch(url + "/");
  assert.match(await page.text(), /Учёт документации/);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors https:\/\/web.telegram.org/,
  );
  const config = await call("/api/config", { auth: null });
  assert.equal(config.body.demo, false);
  assert.equal(config.body.refreshIntervalMs, 15000);
  assert.equal((await call("/api/state", { auth: null })).status, 401);
  const bad = await call("/api/auth/telegram", {
    method: "POST",
    auth: null,
    data: { initData: sign() + "x" },
  });
  assert.equal(bad.status, 401);
  const denied = await call("/api/auth/telegram", {
    method: "POST",
    auth: null,
    data: { initData: sign("900009999") },
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await call("/api/documents", {
        method: "POST",
        data: {},
        headers: { Origin: "https://other.invalid" },
      })
    ).status,
    403,
  );
  const empty = (await call("/api/admin/export")).body;
  assert.equal(empty.tables.documents.length, 0);
  const cron = await fetch(url + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*");
  assert.equal(cron.status, 200);
  let generated;
  for (let i = 0; i < 30; i++) {
    generated = (await call("/api/admin/export")).body;
    if (generated.tables.documents.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    generated.tables.documents.length > 0,
    "cron works without an open app",
  );
  const state = (await call("/api/state")).body;
  assert.equal(state.categories.length, 12);
  assert.equal(state.me.telegram_id, adminId);
  assert.equal(
    (await call("/api/auth/demo-users", { auth: null })).status,
    401,
  );
});
test("Cloudflare atomic document edits, idempotency, conflicts, themes and monthly forty sheets", async () => {
  const data = {
    categoryId: "category-2",
    title: "Cloudflare test",
    dueDate: "2099-11-30",
  };
  const key = randomUUID();
  const created = await call("/api/documents", { method: "POST", data, key });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const repeated = await call("/api/documents", { method: "POST", data, key });
  assert.deepEqual(repeated.body, created.body);
  const changed = await call("/api/documents/" + created.body.id, {
    method: "PATCH",
    data: { ...data, version: created.body.version, title: "Changed" },
  });
  assert.equal(changed.status, 200);
  const stale = await call("/api/documents/" + created.body.id, {
    method: "PATCH",
    data: { ...data, version: created.body.version, title: "Stale" },
  });
  assert.equal(stale.status, 409);
  const state = (await call("/api/state")).body;
  const tue = state.documents.find(
    (d) => d.recurring?.ruleId === "inform-tuesday",
  );
  assert(tue?.topic);
  const edit = await call("/api/documents/" + tue.id, {
    method: "PATCH",
    data: {
      title: tue.title,
      categoryId: tue.categoryId,
      dueDate: tue.dueDate,
      version: tue.version,
      topic: "Ручная тема Cloudflare",
    },
  });
  assert.equal(edit.status, 200);
  const group = state.documents.find((d) => d.categoryId === "category-9");
  assert.equal(group.items.length, 40);
  assert.equal(
    (
      await call("/api/documents/" + group.id + "/actions/place", {
        method: "POST",
        data: { version: group.version, date: state.today },
      })
    ).status,
    400,
  );
  const all = await call("/api/documents/" + group.id + "/items/complete", {
    method: "POST",
    data: { version: group.version },
  });
  assert.equal(all.status, 200);
  assert.equal(all.body.status, "READY");
  assert.equal(
    (await call("/api/state")).body.documents.find((d) => d.id === tue.id)
      .topic,
    "Ручная тема Cloudflare",
  );
});
test("scheduled event creates no duplicates and real durable storage survives runtime restart", async () => {
  const before = (await call("/api/state")).body;
  const response = await fetch(url + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*");
  assert.equal(response.status, 200, await response.text());
  const again = (await call("/api/state")).body;
  assert.equal(again.documents.length, before.documents.length);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  const app = await start("main");
  child = app.p;
  url = app.url;
  session = await login();
  const restored = (await call("/api/state")).body;
  assert.equal(restored.documents.length, before.documents.length);
  assert.equal(restored.audit.length, before.audit.length);
  assert(restored.documents.some((d) => d.topic === "Ручная тема Cloudflare"));
});
test("initial import is authenticated, atomic, retained, one-time and holds cron/login until complete", async () => {
  const app = await start("import", {
    IMPORT_TOKEN: "synthetic-import-secret",
  });
  importChild = app.p;
  importUrl = app.url;
  assert.equal(
    (await call("/api/state", { origin: importUrl, auth: null })).status,
    503,
  );
  await fetch(importUrl + "/cdn-cgi/local/scheduled?cron=*+*+*+*+*");
  const health = (await call("/api/health", { origin: importUrl, auth: null }))
    .body;
  assert.equal(health.migrationPending, true);
  const db = openDb(":memory:");
  initDb(db, { production: true, adminId, demo: false });
  const store = new Store(db);
  const actor = store.users().find((u) => u.admin);
  const d = store.create(actor, {
    title: "Перенесённый документ",
    categoryId: "category-2",
    dueDate: "2099-12-31",
  });
  store.action(actor, d.id, "ready", { version: d.version });
  const snapshot = exportData(db);
  snapshot.schemaVersion = 7;
  delete snapshot.tables.roles;
  delete snapshot.tables.user_roles;
  db.close();
  const send = (data = snapshot, secret = "synthetic-import-secret") =>
    call("/api/admin/import", {
      method: "POST",
      origin: importUrl,
      auth: null,
      data,
      headers: { "X-Import-Token": secret },
    });
  assert.equal((await send(snapshot, "bad")).status, 403);
  const broken = structuredClone(snapshot);
  broken.tables.documents[0].category_id = "missing";
  assert.equal((await send(broken)).status, 500);
  const imported = await send();
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.documents, 1);
  assert.equal((await send()).body.alreadyImported, true);
  const other = structuredClone(snapshot);
  other.exportedAt = "changed";
  assert.equal((await send(other)).status, 409);
  const auth = await login(adminId, importUrl);
  const restored = (await call("/api/state", { origin: importUrl, auth })).body;
  assert.equal(restored.documents.find((x) => x.id === d.id).status, "READY");
  assert.equal(restored.me.id, actor.id);
  const exported = await call("/api/admin/export", { origin: importUrl, auth });
  assert.equal(exported.status, 200);
  assert(!Object.hasOwn(exported.body.tables, "sessions"));
});

test("Cloudflare custom roles enforce rights and revocation across live sessions and a durable restart", async () => {
  const role = await call("/api/roles", {
    method: "POST",
    data: { name: "Облачный оператор", permissions: ["documents.ready"] },
  });
  assert.equal(role.status, 200);
  const user = await call("/api/users", {
    method: "POST",
    data: {
      name: "Облачный участник",
      telegramId: "900005555",
      role: role.body.id,
      active: true,
    },
  });
  assert.equal(user.status, 200);
  let auth = await login("900005555");
  assert.equal(
    (
      await call("/api/roles", {
        method: "POST",
        auth,
        data: { name: "Нельзя", permissions: [] },
      })
    ).status,
    403,
  );
  const created = await call("/api/documents", {
    method: "POST",
    data: {
      title: "Для облачного оператора",
      categoryId: "category-2",
      dueDate: "2099-11-30",
    },
  });
  assert.equal(created.status, 200);
  assert.equal(
    (
      await call("/api/documents/" + created.body.id + "/actions/ready", {
        method: "POST",
        auth,
        data: { version: 1 },
      })
    ).status,
    200,
  );
  const revised = await call("/api/roles/" + role.body.id, {
    method: "PATCH",
    data: { version: 1, name: "Облачный наблюдатель", permissions: [] },
  });
  assert.equal(revised.status, 200);
  assert.equal(
    (
      await call("/api/documents", {
        method: "POST",
        auth,
        data: {
          title: "Запрет",
          categoryId: "category-2",
          dueDate: "2099-11-30",
        },
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/admin/export", { auth })).status, 403);
  const current = (await call("/api/state", { auth })).body;
  assert.equal(current.me.roleName, "Облачный наблюдатель");
  assert.deepEqual(current.me.permissions, []);
  assert.deepEqual(current.audit, []);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  const app = await start("main");
  child = app.p;
  url = app.url;
  session = await login();
  auth = await login("900005555");
  const restored = (await call("/api/state", { auth })).body;
  assert.equal(restored.me.role, role.body.id);
  assert.deepEqual(restored.me.permissions, []);
});

test("Mini App works in Cloudflare with Telegram Web cookies blocked, responsive themes and backup download", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://telegram.org/js/telegram-web-app.js*", (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body:
          "window.Telegram={WebApp:{initData:" +
          JSON.stringify(sign()) +
          ',colorScheme:"light",ready(){},expand(){},onEvent(){},offEvent(){}}}',
      }),
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const headers = { ...request.headers() };
      delete headers.cookie;
      const response = await route.fetch({ headers });
      const reply = { ...response.headers() };
      delete reply["set-cookie"];
      await route.fulfill({ response, headers: reply });
    });
    await page.goto(url);
    await page.getByRole("heading", { name: "Обзор документации" }).waitFor();
    assert.equal(await page.locator(".category-card").count(), 12);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole("button", { name: "Переключить тему", exact: true })
      .click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page
      .locator("nav")
      .getByRole("button", { name: "Управление", exact: true })
      .click();
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Скачать резервную копию", exact: true })
      .click();
    const download = await downloaded;
    assert.match(download.suggestedFilename(), /^vpr-backup-.*\.json$/);
    const file = await download.path();
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(snapshot.format, "vpr-portable-v1");
    assert(snapshot.tables.documents.length > 0);
    assert(!snapshot.tables.sessions);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
