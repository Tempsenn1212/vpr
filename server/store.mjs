import { randomUUID, createHash } from "node:crypto";
import {
  demand,
  text,
  date,
  addDays,
  today,
  deadline,
  readyDeadline,
  summary,
  isCompleted,
  periods,
  proposeSchedule,
  transition,
} from "./domain.mjs";
import {
  can,
  canAssignRole,
  defaultRoles,
  permissionCatalog,
} from "../shared/permissions.ts";
import { userRow } from "./users.mjs";
import { transaction } from "./transaction.mjs";
import { occurrences, SYSTEM_ACTOR_ID } from "./recurrence.mjs";
const cleanTopic = (value) =>
  value == null || (typeof value === "string" && !value.trim())
    ? ""
    : text(value, "Тема лектория", 3000);
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
  hasRoles() {
    this.rolesReady ||= !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='roles'",
      )
      .get();
    return this.rolesReady;
  }
  roles() {
    return this.hasRoles()
      ? this.db
          .prepare("SELECT * FROM roles ORDER BY rowid")
          .all()
          .map((r) => ({ ...r, permissions: JSON.parse(r.permissions) }))
      : structuredClone(defaultRoles);
  }
  decorateUser(row, roles = this.roles(), assignments) {
    if (!row) return null;
    const assigned = assignments
      ? assignments.get(row.id)
      : this.hasRoles()
        ? this.db
            .prepare("SELECT role_id FROM user_roles WHERE user_id=?")
            .get(row.id)?.role_id
        : null;
    const role = roles.find((r) => r.id === (assigned || row.role));
    return {
      ...userRow(row),
      role: role?.id || row.role,
      roleName: role?.name || "Роль",
      permissions: role?.permissions || [],
    };
  }
  users() {
    const roles = this.roles();
    const assignments = new Map(
      this.hasRoles()
        ? this.db
            .prepare("SELECT * FROM user_roles")
            .all()
            .map((r) => [r.user_id, r.role_id])
        : [],
    );
    return this.db
      .prepare("SELECT * FROM users ORDER BY name")
      .all()
      .filter((u) => u.id !== SYSTEM_ACTOR_ID)
      .map((u) => this.decorateUser(u, roles, assignments));
  }
  user(id) {
    return this.decorateUser(
      this.db.prepare("SELECT * FROM users WHERE id=?").get(id),
    );
  }
  require(actor, permission) {
    demand(
      can(actor, permission),
      "Нет права: " +
        (permissionCatalog.find((p) => p.id === permission)?.label ||
          permission),
      403,
    );
  }
  saveRole(actor, id, b) {
    this.require(actor, "roles.manage");
    const name = text(b.name, "Название роли", 80);
    demand(
      Array.isArray(b.permissions) &&
        b.permissions.every(
          (p) =>
            typeof p === "string" && permissionCatalog.some((x) => x.id === p),
        ) &&
        new Set(b.permissions).size === b.permissions.length,
      "Укажите известные права без повторов",
    );
    demand(
      !b.permissions.includes("reviews.create") ||
        b.permissions.includes("reviews.view"),
      "Для фиксации проверок нужен просмотр периодов",
    );
    const roles = this.roles(),
      old = id ? roles.find((r) => r.id === id) : null;
    demand(!id || old, "Роль не найдена", 404);
    demand(
      !old || b.version === old.version,
      "Роль изменена другим участником. Загрузите актуальную версию.",
      409,
    );
    demand(
      !roles.some(
        (r) =>
          r.id !== id &&
          r.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"),
      ),
      "Роль с таким названием уже существует",
    );
    const nextId = id || randomUUID();
    const permissions = permissionCatalog
      .filter((p) => b.permissions.includes(p.id))
      .map((p) => p.id);
    if (
      old &&
      old.name === name &&
      JSON.stringify(old.permissions) === JSON.stringify(permissions)
    )
      return old;
    this.db
      .prepare(
        "INSERT INTO roles(id,name,permissions,version) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,version=roles.version+1",
      )
      .run(nextId, name, JSON.stringify(permissions));
    const after = this.roles().find((r) => r.id === nextId);
    this.audit(actor, "ROLE", null, { before: old, after });
    return after;
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
    return transaction(this.db, () => {
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
        return JSON.parse(old.response);
      }
      const result = fn(current);
      this.db
        .prepare("INSERT INTO request_keys VALUES(?,?,?,?)")
        .run(actor.id, key, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  create(actor, b, recurring = null) {
    if (actor.id !== SYSTEM_ACTOR_ID) this.require(actor, "documents.create");
    this.category(b.categoryId);
    const d = {
      id: randomUUID(),
      title: text(b.title, "Название"),
      categoryId: b.categoryId,
      dueDate: date(b.dueDate),
      readyDueDate: b.readyDueDate ? date(b.readyDueDate) : null,
      topic: cleanTopic(b.topic),
      recurring,
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
    demand(
      !d.readyDueDate || d.readyDueDate <= d.dueDate,
      "Срок оформления не может быть позже вложения",
    );
    const count = b.categoryId === "category-9" ? 40 : 0;
    d.items = Array.from({ length: count }, (_, i) => ({
      id: `item-${i + 1}`,
      label: `Лист беседы №${i + 1}`,
      ready: null,
    }));
    this.write(d);
    this.audit(actor, "CREATE", d.id, { after: d });
    return d;
  }
  edit(actor, id, b) {
    this.require(actor, "documents.edit");
    const old = this.document(id);
    this.check(old, b.version);
    this.category(b.categoryId, b.categoryId === old.categoryId);
    const after = {
      ...old,
      title: text(b.title, "Название"),
      categoryId: b.categoryId,
      dueDate: date(b.dueDate),
    };
    if (b.readyDueDate !== undefined)
      after.readyDueDate = b.readyDueDate ? date(b.readyDueDate) : null;
    if (b.topic !== undefined) {
      demand(
        old.categoryId === "category-6" ||
          !old.recurring?.topicLocked ||
          b.topic === old.topic,
        "Тема задана расписанием и недоступна для изменения",
      );
      after.topic = cleanTopic(b.topic);
    }
    demand(
      !after.readyDueDate || after.readyDueDate <= after.dueDate,
      "Срок оформления не может быть позже вложения",
    );
    demand(
      !old.items?.length || b.categoryId === old.categoryId,
      "Месячную группу листов беседы нельзя перенести в другую категорию",
    );
    demand(
      b.categoryId !== "category-9" || old.categoryId === "category-9",
      "Для листов беседы создайте новую месячную карточку",
    );
    if (b.placementDate !== undefined) {
      demand(old.placement, "Нет действующего вложения");
      const p = date(b.placementDate);
      demand(p <= this.day(), "Фактическая дата не может быть в будущем");
      after.placement = { ...old.placement, date: p };
    }
    const changed =
      ["title", "categoryId", "dueDate"].some((k) => old[k] !== after[k]) ||
      old.placement?.date !== after.placement?.date ||
      (old.readyDueDate || null) !== (after.readyDueDate || null) ||
      (old.topic || "") !== (after.topic || "");
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
    if (
      ["ready", "place", "place-confirm"].includes(action) &&
      old.items?.length
    )
      demand(
        old.items.every((item) => item.ready),
        "Сначала оформите все 40 листов беседы",
      );
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
    this.require(actor, "documents.delete");
    const old = this.document(id);
    this.check(old, b.version);
    demand(b.confirmed === true, "Подтвердите удаление");
    return this.commitDocument(old, { ...old, deleted: true }, actor, "DELETE");
  }
  updateItem(actor, id, itemId, b) {
    if (b.label !== undefined) this.require(actor, "documents.edit");
    if (typeof b.done === "boolean") this.require(actor, "documents.ready");
    const old = this.document(id);
    this.check(old, b.version);
    demand(!isCompleted(old), "Сначала верните месячную группу в работу", 409);
    demand(
      old.items?.some((item) => item.id === itemId),
      "Лист беседы не найден",
      404,
    );
    demand(
      b.label !== undefined || typeof b.done === "boolean",
      "Укажите название или отметку оформления",
    );
    const after = structuredClone(old);
    const item = after.items.find((item) => item.id === itemId);
    const label =
      b.label !== undefined
        ? text(b.label, "Название листа беседы", 150)
        : item.label;
    if (label !== item.label) {
      item.label = label;
      item.ready = null;
    }
    if (typeof b.done === "boolean")
      item.ready = b.done
        ? item.ready || { userId: actor.id, name: actor.name, at: this.now() }
        : null;
    const allReady = after.items.every((item) => item.ready);
    if (allReady && after.status !== "READY") {
      after.status = "READY";
      after.ready = { userId: actor.id, name: actor.name, at: this.now() };
      after.rejection = null;
    } else if (!allReady && after.status === "READY") {
      after.status = "IN_PROGRESS";
      after.ready = null;
    }
    if (JSON.stringify(after) === JSON.stringify(old)) return old;
    return this.commitDocument(old, after, actor, "SUBDOCUMENT", { itemId });
  }
  completeItems(actor, id, b) {
    this.require(actor, "documents.ready");
    const old = this.document(id);
    this.check(old, b.version);
    demand(!isCompleted(old), "Сначала верните месячную группу в работу", 409);
    demand(
      old.categoryId === "category-9" && old.items?.length === 40,
      "Доступно только для группы из 40 листов беседы",
    );
    const after = structuredClone(old);
    const mark = { userId: actor.id, name: actor.name, at: this.now() };
    const itemIds = [];
    for (const item of after.items) {
      if (!item.ready) {
        item.ready = { ...mark };
        itemIds.push(item.id);
      }
    }
    if (after.status !== "READY" || !after.ready) {
      after.status = "READY";
      after.ready = { ...mark };
      after.rejection = null;
    }
    if (JSON.stringify(after) === JSON.stringify(old)) return old;
    return this.commitDocument(old, after, actor, "SUBDOCUMENTS", {
      itemIds,
      markedCount: itemIds.length,
      total: after.items.length,
    });
  }
  recurringRules() {
    return this.db
      .prepare("SELECT * FROM recurring_rules ORDER BY rowid")
      .all();
  }
  invalidateRecurring() {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES('recurring_rules_changed','true') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run();
  }
  saveRecurringRule(actor, id, b) {
    this.require(actor, "schedule.manage");
    const rule = this.recurringRules().find((r) => r.id === id);
    demand(rule, "Расписание не найдено", 404);
    demand(
      b.version === rule.version,
      "Расписание изменено другим участником",
      409,
    );
    demand(typeof b.enabled === "boolean", "Укажите активность расписания");
    const maxReady = rule.cadence === "weekly" ? 7 : 31;
    const maxPlace = rule.cadence === "weekly" ? 14 : 31;
    demand(
      Number.isInteger(b.ready_day) &&
        b.ready_day >= 1 &&
        b.ready_day <= maxReady,
      "Некорректный день оформления",
    );
    demand(
      Number.isInteger(b.placement_day) &&
        b.placement_day >= (rule.cadence === "weekly" ? 0 : 1) &&
        b.placement_day <= maxPlace,
      "Некорректный день вложения",
    );
    demand(
      b.placement_day === 0 || b.placement_day >= b.ready_day,
      "Вложение не может быть раньше оформления",
    );
    this.db
      .prepare(
        "UPDATE recurring_rules SET ready_day=?,placement_day=?,enabled=?,version=version+1 WHERE id=?",
      )
      .run(b.ready_day, b.placement_day, b.enabled ? 1 : 0, id);
    this.invalidateRecurring();
    const after = this.recurringRules().find((r) => r.id === id);
    this.audit(actor, "RECURRENCE", null, { before: rule, after });
    return after;
  }
  syncRecurring() {
    const day = this.day();
    const last = () =>
      this.db
        .prepare("SELECT value FROM meta WHERE key='recurring_last_sync'")
        .get()?.value;
    const changed = () =>
      !!this.db
        .prepare("SELECT value FROM meta WHERE key='recurring_rules_changed'")
        .get();
    if (last() >= day && !changed()) return 0;
    return transaction(this.db, () => {
      const from = last() || day;
      if (from > day) {
        return 0;
      }
      const actor = this.user(SYSTEM_ACTOR_ID);
      let created = 0;
      for (const rule of this.recurringRules()) {
        if (
          !rule.enabled ||
          this.categories().find((c) => c.id === rule.category_id)?.hidden
        )
          continue;
        for (const occurrence of occurrences(rule, from, day)) {
          if (
            this.db
              .prepare(
                "SELECT 1 FROM recurring_occurrences WHERE rule_id=? AND period_key=?",
              )
              .get(rule.id, occurrence.key)
          )
            continue;
          const doc = this.create(
            actor,
            {
              categoryId: rule.category_id,
              title: `${rule.title} · ${occurrence.label}`,
              dueDate: occurrence.dueDate,
              readyDueDate: occurrence.readyDueDate,
              topic: rule.topic,
            },
            {
              ruleId: rule.id,
              periodKey: occurrence.key,
              start: occurrence.start,
              end: occurrence.end,
              topicLocked: !!rule.topic_locked,
            },
          );
          this.db
            .prepare("INSERT INTO recurring_occurrences VALUES(?,?,?)")
            .run(rule.id, occurrence.key, doc.id);
          created++;
        }
      }
      this.db
        .prepare(
          "INSERT INTO meta VALUES('recurring_last_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(day);
      this.db
        .prepare("DELETE FROM meta WHERE key='recurring_rules_changed'")
        .run();
      return created;
    });
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
    this.require(actor, "documents.confirm");
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
          reason: "Дополнительное подтверждение недоступно в этом статусе",
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
    this.require(actor, "reviews.create");
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
    this.require(actor, "schedule.manage");
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
    demand(
      id !== SYSTEM_ACTOR_ID,
      "Системный участник недоступен для изменения",
      403,
    );
    this.require(actor, "users.manage");
    const role = this.roles().find((r) => r.id === b.role);
    demand(role, "Неизвестная рабочая роль");
    demand(
      canAssignRole(actor, role),
      "Нельзя назначить права, которых у вас нет",
      403,
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
    demand(
      !old?.admin || actor.admin,
      "Только администратор может менять свою учётную запись",
      403,
    );
    demand(
      !old || canAssignRole(actor, { permissions: old.permissions }),
      "Нельзя менять участника с более широкими правами",
      403,
    );
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
        b.role === "CHIEF" ? "CHIEF" : "WORKER",
        old?.admin ? 1 : 0,
        active ? 1 : 0,
      );
    if (this.hasRoles()) {
      if (b.role === "WORKER" || b.role === "CHIEF")
        this.db.prepare("DELETE FROM user_roles WHERE user_id=?").run(nextId);
      else
        this.db
          .prepare(
            "INSERT INTO user_roles VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET role_id=excluded.role_id",
          )
          .run(nextId, b.role);
    }
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
    this.require(actor, "categories.manage");
    const name = text(b.name, "Название категории", 300);
    demand(
      Number.isInteger(b.position) && b.position >= 0 && b.position <= 10000,
      "Порядок: целое число 0–10000",
    );
    const old = id ? this.categories().find((c) => c.id === id) : null;
    demand(!id || old, "Категория не найдена", 404);
    if (b.hidden)
      demand(
        !this.documents().some(
          (d) => !d.deleted && d.categoryId === id && !isCompleted(d),
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
    this.invalidateRecurring();
    return { id: nextId };
  }
  state(actor) {
    const docs = this.documents().map((d) => ({
      ...d,
      completed: isCompleted(d),
      deadline: deadline(d, this.day()),
      readyDeadline: readyDeadline(d, this.day(), this.zone),
    }));
    const list = this.periodList();
    const records = this.db
      .prepare("SELECT * FROM review_records ORDER BY at DESC")
      .all()
      .map((r) => ({ ...r, snapshot: JSON.parse(r.snapshot) }));
    return {
      me: actor,
      roles: this.roles(),
      today: this.day(),
      timeZone: this.zone,
      documents: docs,
      categories: this.categories(),
      users: this.users().map((u) =>
        can(actor, "users.manage")
          ? u
          : {
              id: u.id,
              name: u.name,
              role: u.role,
              roleName: u.roleName,
              active: u.active,
            },
      ),
      periods: list,
      reviewRecords: can(actor, "reviews.view") ? records : [],
      scheduleVersions: this.allVersions(),
      recurringRules: this.recurringRules(),
      audit: !can(actor, "history.view")
        ? []
        : this.db
            .prepare("SELECT * FROM audit_events ORDER BY seq DESC")
            .all()
            .map((e) => ({ ...e, data: JSON.parse(e.data) })),
    };
  }
}
