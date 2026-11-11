import express from "express";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { openDb, initDb } from "./db.mjs";
import { Store } from "./store.mjs";
import { seedDemo } from "./seed.mjs";
import { demand, Problem } from "./domain.mjs";
import { validateTelegram, newSession, sessionUser } from "./auth.mjs";
export function createApp(options = {}) {
  const config = {
    production: process.env.NODE_ENV === "production",
    demo: process.env.DEV_AUTH === "true",
    database: process.env.DATABASE_PATH || "data/vpr.sqlite",
    adminId: process.env.INITIAL_ADMIN_TELEGRAM_ID,
    botToken: process.env.BOT_TOKEN,
    origin: process.env.APP_ORIGIN || "http://localhost:5173",
    zone: process.env.APP_TIMEZONE || "Europe/Moscow",
    ...options,
  };
  demand(!(config.production && config.demo), "DEV_AUTH запрещён в production");
  if (config.production) {
    demand(config.botToken, "В production нужен BOT_TOKEN");
    demand(
      /^https:\/\//.test(config.origin),
      "В production нужен HTTPS APP_ORIGIN",
    );
  }
  new Intl.DateTimeFormat("en", { timeZone: config.zone });
  const db = openDb(config.database);
  initDb(db, config);
  const store = new Store(db, { zone: config.zone, clock: config.clock });
  if (config.demo && options.seed !== false) seedDemo(store);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org",
    });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      if (origin && origin !== config.origin)
        return res.status(403).json({ error: "Недопустимый источник запроса" });
    }
    next();
  });
  const rate = new Map();
  const authRate = (req, res, next) => {
    const now = Date.now();
    if (rate.size > 10000)
      for (const [k, v] of rate) if (now - v.at > 60000) rate.delete(k);
    let r = rate.get(req.ip);
    if (!r || now - r.at > 60000) {
      r = { at: now, n: 0 };
      rate.set(req.ip, r);
    }
    if (++r.n > 30)
      return res
        .status(429)
        .json({
          error: "Слишком много попыток входа. Повторите через минуту.",
        });
    next();
  };
  const login = (req, res, user) => {
    demand(
      user?.active,
      "Доступ не предоставлен. Обратитесь к администратору.",
      403,
    );
    const token = newSession(db, user.id);
    res.cookie("vpr_session", token, {
      httpOnly: true,
      secure: config.production,
      sameSite: "strict",
      maxAge: 8 * 3600000,
      path: "/",
    });
    res.json({ me: user });
  };
  app.get("/api/config", (req, res) =>
    res.json({ demo: config.demo, appName: "Учёт документации ВПР" }),
  );
  app.get("/api/health", (req, res) => {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/api/auth/demo-users", (req, res) => {
    demand(config.demo && !config.production, "Не найдено", 404);
    res.json(
      store
        .users()
        .filter((u) => u.active)
        .map(({ id, name, role, admin }) => ({ id, name, role, admin })),
    );
  });
  app.post("/api/auth/demo", authRate, (req, res) => {
    demand(config.demo && !config.production, "Не найдено", 404);
    login(req, res, store.user(req.body.userId));
  });
  app.post("/api/auth/telegram", authRate, (req, res) => {
    const telegramId = validateTelegram(req.body.initData, config.botToken);
    login(
      req,
      res,
      store.users().find((u) => u.telegram_id === telegramId),
    );
  });
  app.use("/api", (req, res, next) => {
    req.actor = sessionUser(req, store);
    demand(
      req.actor,
      "Доступ не предоставлен или сессия истекла. Откройте приложение заново.",
      401,
    );
    next();
  });
  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("vpr_session", { path: "/" });
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.actor.id);
    res.json({ ok: true });
  });
  app.get("/api/state", (req, res) => res.json(store.state(req.actor)));
  const mutation = (path, fn, method = "post") =>
    app[method](path, (req, res) =>
      res.json(
        store.mutate(
          req.actor,
          req.get("Idempotency-Key"),
          req.method + req.originalUrl,
          req.body,
          (actor) => fn(actor, req.body, req.params),
        ),
      ),
    );
  mutation("/api/documents", (a, b) => store.create(a, b));
  mutation("/api/documents/:id", (a, b, p) => store.edit(a, p.id, b), "patch");
  mutation("/api/documents/:id/actions/:action", (a, b, p) =>
    store.action(a, p.id, p.action, b),
  );
  mutation(
    "/api/documents/:id",
    (a, b, p) => store.remove(a, p.id, b),
    "delete",
  );
  mutation("/api/batches/confirm", (a, b) => store.batch(a, b));
  mutation("/api/reviews", (a, b) => store.review(a, b));
  app.post("/api/schedule/preview", (req, res) => {
    demand(
      req.actor.admin || req.actor.role === "CHIEF",
      "Нет права менять расписание",
      403,
    );
    res.json(store.schedulePreview(req.body));
  });
  mutation("/api/schedule", (a, b) => store.changeSchedule(a, b));
  mutation("/api/users", (a, b) => store.saveUser(a, null, b));
  mutation("/api/users/:id", (a, b, p) => store.saveUser(a, p.id, b), "patch");
  mutation("/api/admin/transfer", (a, b) => store.transfer(a, b));
  mutation("/api/categories", (a, b) => store.saveCategory(a, null, b));
  mutation(
    "/api/categories/:id",
    (a, b, p) => store.saveCategory(a, p.id, b),
    "patch",
  );
  app.use("/api", (req, res) => res.status(404).json({ error: "Не найдено" }));
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*splat}", (req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use((e, req, res, next) => {
    const status =
      e instanceof Problem
        ? e.status
        : e.type === "entity.parse.failed"
          ? 400
          : 500;
    res
      .status(status)
      .json({
        error:
          status === 500
            ? "Ошибка сервера. Изменения не сохранены."
            : e.message,
        details: e.details,
      });
    if (status === 500)
      console.error("Server failure:", e.name, e.code || "internal");
  });
  return { app, store, db, config };
}
