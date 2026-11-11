import { randomUUID, createHash } from "node:crypto";
import {
  demand,
  text,
  date,
  addDays,
  today,
  deadline,
  summary,
  periods,
  proposeSchedule,
  transition,
} from "./domain.mjs";
import { userRow } from "./db.mjs";
export class Store {
  constructor(db, { zone = "Europe/Moscow", clock = () => new Date() } = {}) {
    this.db = db;
    this.zone = zone;
    this.clock = clock;
  }
  now() {
    return this.clock().toISOString();
  }
  day() {
    return today(this.clock(), this.zone);
  }
  users() {
    return this.db
      .prepare("SELECT * FROM users ORDER BY name")
      .all()
      .map(userRow);
  }
  user(id) {
    return userRow(this.db.prepare("SELECT * FROM users WHERE id=?").get(id));
  }
  categories() {
    return this.db
      .prepare("SELECT * FROM categories ORDER BY position,name")
      .all()
      .map((c) => ({ ...c, hidden: !!c.hidden }));
  }
  documents() {
    return this.db
      .prepare("SELECT data FROM documents ORDER BY due_date,id")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  document(id) {
    const row = this.db
      .prepare("SELECT data FROM documents WHERE id=?")
      .get(id);
    demand(row, "Карточка не найдена", 404);
    return JSON.parse(row.data);
  }
  category(id, allowHidden = false) {
    const c = this.categories().find((c) => c.id === id);
    demand(c && (allowHidden || !c.hidden), "Категория недоступна");
    return c;
  }
  check(d, version) {
    demand(!d.deleted, "Карточка удалена", 409);
    demand(
      Number.isInteger(version) && d.version === version,
      "Карточка изменена другим участником. Получены свежие данные.",
      409,
      { document: d },
    );
  }
  audit(actor, type, documentId, data, batchId = null) {
    if (documentId)
      data = {
        ...data,
        categoryNames: Object.fromEntries(
          this.categories().map((c) => [c.id, c.name]),
        ),
      };
    this.db
      .prepare(
        "INSERT INTO audit_events(id,document_id,actor_id,actor_name,type,at,batch_id,data) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        documentId,
        actor.id,
        actor.name,
        type,
        this.now(),
        batchId,
        JSON.stringify(data),
      );
  }
  write(d) {
    this.db
      .prepare(
        "INSERT INTO documents VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,due_date=excluded.due_date,status=excluded.status,version=excluded.version,deleted=excluded.deleted,data=excluded.data",
      )
      .run(
        d.id,
        d.categoryId,
        d.dueDate,
        d.status,
        d.version,
        d.deleted ? 1 : 0,
        JSON.stringify(d),
      );
    return d;
  }
  commitDocument(before, after, actor, type, extra = {}, batchId = null) {
    after.version = before.version + 1;
    after.updatedAt = this.now();
    this.write(after);
    this.audit(actor, type, after.id, { before, after, ...extra }, batchId);
    return after;
  }
  mutate(actor, key, path, body, fn) {
    demand(
      typeof key === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(key),
      "Нужен Idempotency-Key (16–100 знаков)",
    );
    const fingerprint = createHash("sha256")
      .update(path + "\n" + JSON.stringify(body))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.user(actor.id);
      demand(current?.active, "Доступ отключён", 403);
      const old = this.db
        .prepare("SELECT * FROM request_keys WHERE actor_id=? AND key=?")
        .get(actor.id, key);
      if (old) {
        demand(
          old.fingerprint === fingerprint,
          "Ключ запроса уже использован для другого действия",
          409,
        );
        this.db.exec("COMMIT");
        return JSON.parse(old.response);
      }
      const result = fn(current);
      this.db
        .prepare("INSERT INTO request_keys VALUES(?,?,?,?)")
        .run(actor.id, key, fingerprint, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  create(actor, b) {
    this.category(b.categoryId);
    const d = {
      id: randomUUID(),
      title: text(b.title, "Название"),
      categoryId: b.categoryId,
      dueDate: date(b.dueDate),
      status: "IN_PROGRESS",
      version: 1,
      createdBy: { userId: actor.id, name: actor.name },
      createdAt: this.now(),
      updatedAt: this.now(),
      ready: null,
      placement: null,
      confirmation: null,
      rejection: null,
      deleted: false,
    };
    this.write(d);
    this.audit(actor, "CREATE", d.id, { after: d });
    return d;
  }
  edit(actor, id, b) {
    const old = this.document(id);
    this.check(old, b.version);
    this.category(b.categoryId, b.categoryId === old.categoryId);
    const after = {
      ...old,
      title: text(b.title, "Название"),
      categoryId: b.categoryId,
      dueDate: date(b.dueDate),
    };
    if (b.placementDate !== undefined) {
      demand(old.placement, "Нет действующего вложения");
      const p = date(b.placementDate);
      demand(p <= this.day(), "Фактическая дата не может быть в будущем");
      after.placement = { ...old.placement, date: p };
    }
    const changed =
      ["title", "categoryId", "dueDate"].some((k) => old[k] !== after[k]) ||
      old.placement?.date !== after.placement?.date;
    if (!changed) return old;
    if (old.status === "CONFIRMED") {
      demand(
        b.acknowledgeReset === true,
        "Подтвердите снятие подтверждения при изменении карточки",
      );
      after.confirmation = null;
      after.status = "PLACED";
    }
    return this.commitDocument(old, after, actor, "EDIT", {
      confirmationReset: old.status === "CONFIRMED",
    });
  }
  action(actor, id, action, b, batchId = null) {
    const old = this.document(id);
    this.check(old, b.version);
    const after = transition(old, action, b, actor, this.now(), this.day());
    return this.commitDocument(
      old,
      after,
      actor,
      action.toUpperCase(),
      { reason: b.reason ? text(b.reason, "Причина", 1000) : undefined },
      batchId,
    );
  }
  remove(actor, id, b) {
    const old = this.document(id);
    this.check(old, b.version);
    demand(b.confirmed === true, "Подтвердите удаление");
    return this.commitDocument(old, { ...old, deleted: true }, actor, "DELETE");
  }
  allVersions() {
    return this.db
      .prepare("SELECT * FROM schedule_versions ORDER BY seq")
      .all()
      .map((v) => ({
        id: v.id,
        anchor: v.anchor,
        interval: v.interval,
        effectiveStart: v.effective_start,
        actorId: v.actor_id,
        at: v.at,
      }));
  }
  versions() {
    const all = this.allVersions();
    const override = this.db
      .prepare("SELECT value FROM meta WHERE key=?")
      .get("schedule_initial_override")?.value;
    return override ? all.slice(all.findIndex((v) => v.id === override)) : all;
  }
  periodList() {
    return periods(this.versions(), addDays(this.day(), 366));
  }
  period(id) {
    const p = this.periodList().find((p) => p.id === id);
    demand(p, "Период не найден", 404);
    return p;
  }
  periodDocs(p) {
    return this.documents().filter(
      (d) => !d.deleted && d.dueDate >= p.start && d.dueDate <= p.end,
    );
  }
  persistPeriod(p) {
    this.db
      .prepare("INSERT OR IGNORE INTO review_periods VALUES(?,?,?,?,?)")
      .run(p.id, p.start, p.end, p.scheduleId, JSON.stringify(p));
  }
  batch(actor, b) {
    demand(actor.role === "CHIEF", "Доступно только начальнику", 403);
    const p = this.period(b.periodId);
    demand(
      b.categoryId === "ALL" ||
        this.categories().some((c) => c.id === b.categoryId),
      "Явно выберите категорию или ALL",
    );
    demand(
      Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 1000,
      "Выберите от 1 до 1000 карточек",
    );
    demand(
      b.items.every(
        (x) =>
          x &&
          typeof x.id === "string" &&
          Number.isInteger(x.version) &&
          x.version > 0,
      ),
      "Некорректный ID или версия выбранной карточки",
    );
    demand(
      new Set(b.items.map((x) => x.id)).size === b.items.length,
      "Повторяющиеся карточки",
    );
    const id = randomUUID();
    const results = [];
    for (const item of b.items) {
      const d = this.documents().find((x) => x.id === item.id);
      if (
        !d ||
        d.deleted ||
        d.dueDate < p.start ||
        d.dueDate > p.end ||
        (b.categoryId !== "ALL" && d.categoryId !== b.categoryId)
      ) {
        results.push({
          id: item.id,
          result: "skipped",
          reason: "Вне области выбора",
        });
        continue;
      }
      if (d.version !== item.version) {
        results.push({ id: item.id, result: "conflict" });
        continue;
      }
      if (d.status !== "PLACED") {
        results.push({
          id: item.id,
          result: "skipped",
          reason: "Не ожидает подтверждения",
        });
        continue;
      }
      this.action(actor, item.id, "confirm", { version: item.version }, id);
      results.push({ id: item.id, result: "confirmed" });
    }
    const result = {
      id,
      confirmed: results.filter((x) => x.result === "confirmed").length,
      skipped: results.filter((x) => x.result === "skipped").length,
      conflicts: results.filter((x) => x.result === "conflict").length,
      results,
    };
    this.db.prepare("INSERT INTO batch_operations VALUES(?,?,?,?)").run(
      id,
      actor.id,
      this.now(),
      JSON.stringify({
        scope: { periodId: p.id, categoryId: b.categoryId },
        ...result,
      }),
    );
    return result;
  }
  review(actor, b) {
    demand(actor.role === "CHIEF", "Доступно только начальнику", 403);
    const p = this.period(b.periodId);
    this.persistPeriod(p);
    const docs = this.periodDocs(p);
    const snapshot = {
      period: p,
      documents: docs,
      summary: summary(docs),
      capturedAt: this.now(),
    };
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO review_records VALUES(?,?,?,?,?,?)")
      .run(
        id,
        p.id,
        actor.id,
        actor.name,
        this.now(),
        JSON.stringify(snapshot),
      );
    this.audit(actor, "REVIEW", null, { id, snapshot });
    return { id, snapshot };
  }
  schedulePreview(b) {
    const versions = this.versions();
    const next = { ...proposeSchedule(versions, b, this.day()), id: "preview" };
    const kept =
      this.day() < versions[0].effectiveStart
        ? []
        : versions.filter((v) => v.effectiveStart < next.effectiveStart);
    return {
      next,
      periods: periods(
        [...kept, next],
        addDays(next.effectiveStart, Math.max(90, b.interval * 3)),
      )
        .filter((p) => p.start >= next.effectiveStart)
        .slice(0, 3),
    };
  }
  changeSchedule(actor, b) {
    demand(
      actor.admin || actor.role === "CHIEF",
      "Нет права менять расписание",
      403,
    );
    demand(
      b.expectedVersion === this.versions().at(-1).id,
      "Расписание уже изменено. Обновите данные.",
      409,
    );
    const preview = this.schedulePreview(b);
    const id = randomUUID();
    const v = preview.next;
    if (this.day() < this.versions()[0].effectiveStart) {
      // Earlier versions remain retained, excluded via superseded boundary marker.
      this.db
        .prepare(
          "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run("schedule_initial_override", id);
    }
    this.db
      .prepare(
        "INSERT INTO schedule_versions(id,effective_start,anchor,interval,actor_id,at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, v.effectiveStart, v.anchor, v.interval, actor.id, this.now());
    this.audit(actor, "SCHEDULE", null, {
      before: b.expectedVersion,
      after: { ...v, id },
    });
    return { id, ...preview };
  }
  admin(actor) {
    demand(actor.admin, "Доступно только администратору", 403);
  }
  saveUser(actor, id, b) {
    this.admin(actor);
    demand(
      b.role === "WORKER" || b.role === "CHIEF",
      "Неизвестная рабочая роль",
    );
    const name = text(b.name, "Имя", 100);
    demand(
      /^\d{1,16}$/.test(b.telegramId || "") &&
        Number.isSafeInteger(Number(b.telegramId)) &&
        Number(b.telegramId) > 0,
      "Некорректный Telegram ID",
    );
    const old = id ? this.user(id) : null;
    demand(!id || old, "Участник не найден", 404);
    const active = b.active !== false;
    demand(!(old?.admin && !active), "Сначала передайте администрирование");
    const duplicate = this.users().find(
      (u) => u.telegram_id === b.telegramId && u.id !== id,
    );
    demand(!duplicate, "Telegram ID уже добавлен");
    const nextId = id || randomUUID();
    this.db
      .prepare(
        "INSERT INTO users VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET telegram_id=excluded.telegram_id,name=excluded.name,role=excluded.role,active=excluded.active",
      )
      .run(
        nextId,
        b.telegramId,
        name,
        b.role,
        old?.admin ? 1 : 0,
        active ? 1 : 0,
      );
    const after = this.user(nextId);
    this.audit(actor, "USER", null, { before: old, after });
    return after;
  }
  transfer(actor, b) {
    this.admin(actor);
    const target = this.user(b.userId);
    demand(
      target?.active && target.id !== actor.id,
      "Выберите другого активного участника",
    );
    this.db.prepare("UPDATE users SET admin=1 WHERE id=?").run(target.id);
    this.db.prepare("UPDATE users SET admin=0 WHERE id=?").run(actor.id);
    this.audit(actor, "TRANSFER_ADMIN", null, {
      from: actor.id,
      to: target.id,
    });
    return { userId: target.id };
  }
  saveCategory(actor, id, b) {
    this.admin(actor);
    const name = text(b.name, "Название категории", 100);
    demand(
      Number.isInteger(b.position) && b.position >= 0 && b.position <= 10000,
      "Порядок: целое число 0–10000",
    );
    const old = id ? this.categories().find((c) => c.id === id) : null;
    demand(!id || old, "Категория не найдена", 404);
    if (b.hidden)
      demand(
        !this.documents().some(
          (d) => !d.deleted && d.categoryId === id && d.status !== "CONFIRMED",
        ),
        "Сначала обработайте или перенесите незавершённые документы",
      );
    const nextId = id || randomUUID();
    this.db
      .prepare(
        "INSERT INTO categories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position,hidden=excluded.hidden",
      )
      .run(nextId, name, b.position, b.hidden ? 1 : 0);
    this.audit(actor, "CATEGORY", null, {
      before: old,
      after: { id: nextId, ...b, name },
    });
    return { id: nextId };
  }
  state(actor) {
    const docs = this.documents().map((d) => ({
      ...d,
      deadline: deadline(d, this.day()),
    }));
    const list = this.periodList();
    const records = this.db
      .prepare("SELECT * FROM review_records ORDER BY at DESC")
      .all()
      .map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) }));
    return {
      me: actor,
      today: this.day(),
      timeZone: this.zone,
      documents: docs,
      categories: this.categories(),
      users: this.users().map((u) =>
        actor.admin
          ? u
          : { id: u.id, name: u.name, role: u.role, active: u.active },
      ),
      periods: list,
      reviewRecords: records,
      scheduleVersions: this.allVersions(),
      audit: this.db
        .prepare("SELECT * FROM audit_events ORDER BY seq DESC")
        .all()
        .map((e) => ({ ...e, data: JSON.parse(e.data) })),
    };
  }
}
