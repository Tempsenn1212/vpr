import { DurableObject } from "cloudflare:workers";
import { Store } from "../server/store.mjs";
import { initDb } from "../server/initialize.mjs";
import { demand, Problem } from "../server/domain.mjs";
import {
  validateTelegram,
  newSession,
  sessionUser,
  digest,
} from "../server/auth.mjs";
import { sqliteAdapter } from "./sqlite.mjs";
import { migrate } from "./schema.mjs";
import { findRoute } from "./routes.mjs";
import { exportData, importData } from "../server/portable-backup.mjs";

const security = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org",
};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...security, ...headers },
  });
async function body(request, max = 32768) {
  demand(
    Number(request.headers.get("content-length") || 0) <= max,
    "Слишком большой запрос",
    413,
  );
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      demand(false, "Слишком большой запрос", 413);
    }
    chunks.push(value);
  }
  try {
    const buf = new Uint8Array(size);
    let pos = 0;
    for (const c of chunks) {
      buf.set(c, pos);
      pos += c.length;
    }
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new Problem(400, "Некорректный JSON");
  }
}
export class VprDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = sqliteAdapter(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.db);
    });
    this.store = new Store(this.db, {
      zone: env.APP_TIMEZONE || "Europe/Moscow",
    });
  }
  ready() {
    demand(
      this.env.BOT_TOKEN && this.env.INITIAL_ADMIN_TELEGRAM_ID,
      "Cloudflare ещё не настроен. Выполните npm run cloudflare:setup.",
      503,
    );
    initDb(this.db, {
      production: true,
      demo: false,
      adminId: this.env.INITIAL_ADMIN_TELEGRAM_ID,
    });
  }
  importing() {
    return (
      !!this.env.IMPORT_TOKEN &&
      !this.db
        .prepare("SELECT 1 FROM meta WHERE key='cloudflare_imported'")
        .get()
    );
  }
  sync() {
    this.ready();
    if (this.importing() || this.env.AUTOMATIC_DOCUMENTS === "false")
      return { created: 0 };
    return { created: this.store.syncRecurring() };
  }
  rate(request) {
    const ip = digest(request.headers.get("CF-Connecting-IP") || "local");
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM _vpr_auth_rate WHERE at<?").run(now - 60000);
      const old = this.db
        .prepare("SELECT * FROM _vpr_auth_rate WHERE ip=?")
        .get(ip);
      demand(
        !old || old.count < 30,
        "Слишком много попыток входа. Повторите через минуту.",
        429,
      );
      this.db
        .prepare(
          "INSERT INTO _vpr_auth_rate VALUES(?,?,1) ON CONFLICT(ip) DO UPDATE SET count=count+1",
        )
        .run(ip, old?.at || now);
    });
  }
  async fetch(request) {
    try {
      const url = new URL(request.url),
        path = url.pathname,
        method = request.method;
      const origin = request.headers.get("origin");
      if (!["GET", "HEAD", "OPTIONS"].includes(method))
        demand(
          !origin || origin === url.origin,
          "Недопустимый источник запроса",
          403,
        );
      if (path === "/api/config" && method === "GET")
        return json({
          demo: false,
          appName: "Учёт документации ВПР",
          refreshIntervalMs: 15000,
        });
      if (path === "/api/health" && method === "GET") {
        this.ready();
        return json({
          ok: true,
          storage: "durable-sqlite",
          migrationPending: this.importing(),
        });
      }
      if (path === "/api/admin/import" && method === "POST") {
        this.ready();
        demand(
          this.env.IMPORT_TOKEN &&
            digest(request.headers.get("X-Import-Token") || "") ===
              digest(this.env.IMPORT_TOKEN),
          "Доступ запрещён",
          403,
        );
        const snapshot = await body(request, 20 * 1024 * 1024);
        return json(
          importData(this.db, snapshot, this.env.INITIAL_ADMIN_TELEGRAM_ID),
        );
      }
      demand(
        !this.importing(),
        "Идёт первоначальный перенос базы. Завершите cloudflare:setup.",
        503,
      );
      if (path === "/api/auth/telegram" && method === "POST") {
        this.rate(request);
        const b = await body(request);
        this.ready();
        const id = validateTelegram(b.initData, this.env.BOT_TOKEN);
        const user = this.store.users().find((u) => u.telegram_id === id);
        demand(
          user?.active,
          "Доступ не предоставлен. Обратитесь к администратору.",
          403,
        );
        const token = newSession(this.db, user.id);
        return json({ me: user, sessionToken: token }, 200, {
          "Set-Cookie": `vpr_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
        });
      }
      this.ready();
      const actor = sessionUser(
        {
          headers: {
            authorization: request.headers.get("authorization") ?? undefined,
            cookie: request.headers.get("cookie") ?? undefined,
          },
        },
        this.store,
      );
      demand(
        actor,
        "Доступ не предоставлен или сессия истекла. Откройте приложение заново.",
        401,
      );
      if (path === "/api/auth/logout" && method === "POST") {
        this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(actor.id);
        return json({ ok: true }, 200, {
          "Set-Cookie":
            "vpr_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        });
      }
      if (path === "/api/state" && method === "GET") {
        this.sync();
        return json({ ...this.store.state(actor), portableBackup: true });
      }
      if (path === "/api/admin/export" && method === "GET") {
        this.store.require(actor, "backup.export");
        return json(exportData(this.db));
      }
      if (path === "/api/schedule/preview" && method === "POST") {
        this.store.require(actor, "schedule.manage");
        return json(this.store.schedulePreview(await body(request)));
      }
      const route = findRoute(method, path);
      demand(route, "Не найдено", 404);
      const b = await body(request);
      return json(
        this.store.mutate(
          actor,
          request.headers.get("Idempotency-Key"),
          method + path + url.search,
          b,
          (a) => route.fn(this.store, a, b, route.params),
        ),
      );
    } catch (error) {
      const status = error instanceof Problem ? error.status : 500;
      if (status === 500) console.error("Cloudflare failure:", error.name);
      return json(
        {
          error:
            status === 500
              ? "Ошибка сервера. Изменения не сохранены."
              : error.message,
          details: error.details,
        },
        status,
      );
    }
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api" || path.startsWith("/api/"))
      return env.VPR_DB.get(env.VPR_DB.idFromName("vpr-main")).fetch(request);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(security))
      if (k !== "Content-Type" && k !== "Cache-Control") headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event, env) {
    await env.VPR_DB.get(env.VPR_DB.idFromName("vpr-main")).sync();
  },
};
