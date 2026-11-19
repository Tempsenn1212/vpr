import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../server/app.mjs";

const test = base.extend({
  recurringApp: async ({}, use) => {
    const instance = createApp({
      database: ":memory:",
      demo: true,
      production: false,
      seed: false,
      automation: true,
      clock: () => new Date("2026-11-15T12:00:00Z"),
    });
    const server = instance.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    instance.config.origin = url;
    try {
      await use({ ...instance, url });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      instance.db.close();
    }
  },
});
async function login(page, app, allMonths = true) {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (r) =>
    r.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.goto(app.url);
  await page.getByRole("button", { name: /Анна Смирнова/ }).click();
  await expect(
    page.getByRole("heading", { name: "Обзор документации" }),
  ).toBeVisible();
  if (allMonths) {
    await page
      .getByRole("combobox", { name: "Месяц документов", exact: true })
      .click();
    await page.getByRole("option", { name: "Все месяцы", exact: true }).click();
  }
}
async function mutate(page, app, path, body, method = "post") {
  const response = await page.request[method](app.url + "/api" + path, {
    data: body,
    headers: { "Idempotency-Key": randomUUID() },
  });
  expect(response.status()).toBe(200);
  return response.json();
}
async function chooseMonth(page, name) {
  await page
    .getByRole("combobox", { name: "Месяц документов", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Поиск: Месяц документов", exact: true })
    .fill(name);
  await page.getByRole("option", { name, exact: true }).click();
}
function monthDocuments(app) {
  const actor = app.store.user("worker-1");
  const create = (title, dueDate, extra = {}) =>
    app.store.create(actor, {
      title,
      dueDate,
      categoryId: "category-2",
      ...extra,
    });
  const october = create("Октябрьский документ", "2026-10-31");
  app.store.action(actor, october.id, "place", {
    version: october.version,
    date: "2026-11-06",
  });
  create("Ноябрь в работе", "2026-11-30");
  const ready = create("Ноябрь оформлен", "2026-11-30", {
    readyDueDate: "2026-11-25",
  });
  app.store.action(actor, ready.id, "ready", {
    version: ready.version,
    date: "2026-11-13",
  });
  const done = create("Ноябрь завершён", "2026-11-01");
  app.store.action(actor, done.id, "place", {
    version: done.version,
    date: "2026-11-14",
  });
  create("Декабрьский документ", "2026-12-01", { readyDueDate: "2026-11-25" });
  create("Високосный февраль", "2028-02-29");
  const deleted = create("Удалённый старый документ", "2025-05-01");
  app.store.remove(actor, deleted.id, {
    version: deleted.version,
    confirmed: true,
  });
  return app.store.state(actor);
}
test("month selection scopes every summary, category and table by deadline and preserves stored facts", async ({
  page,
  recurringApp: app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = monthDocuments(app),
    before = app.store.documents();
  const current = state.documents.filter(
    (d) => !d.deleted && d.dueDate.startsWith("2026-11"),
  );
  await login(page, app, false);
  const month = page.getByRole("combobox", {
    name: "Месяц документов",
    exact: true,
  });
  await expect(month).toContainText("Ноябрь 2026");
  for (const [kind, count] of [
    ["primary", current.length],
    ["working", current.filter((d) => d.status === "IN_PROGRESS").length],
    ["ready", 1],
    ["red", current.filter((d) => d.deadline.kind === "overdue").length],
    ["amber", 1],
  ])
    await expect(page.locator(`.stat-${kind} strong`)).toHaveText(
      String(count),
    );
  const category = () =>
    page
      .locator(".category-card")
      .filter({ hasText: "Планы основных культурно-досуговых мероприятий" });
  await expect(category()).toContainText("Документов: 3");
  await page.locator(".stat-amber").click();
  await expect(page.locator("tbody .table-title")).toHaveText([
    "Ноябрь завершён",
  ]);
  await page.locator(".tab-all").click();
  await expect(page.locator("tbody tr")).toHaveCount(current.length);
  await chooseMonth(page, "Октябрь 2026");
  await expect(page.locator("tbody .table-title")).toHaveText([
    "Октябрьский документ",
  ]);
  await page
    .getByRole("button", { name: "Октябрьский документ", exact: true })
    .click();
  await expect(page.getByRole("dialog").locator(".marks")).toContainText(
    "6 нояб. 2026",
  );
  await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  const home = () =>
    page
      .locator("nav")
      .getByRole("button", { name: "Обзор", exact: true })
      .click();
  await home();
  await expect(month).toContainText("Октябрь 2026");
  await expect(page.locator(".stat-primary strong")).toHaveText("1");
  await expect(page.locator(".stat-amber strong")).toHaveText("1");
  await expect(category()).toContainText("Документов: 1");
  await category().click();
  await expect(page.locator(".document-row .doc-main b")).toHaveText([
    "Октябрьский документ",
  ]);
  await chooseMonth(page, "Декабрь 2026");
  await expect(page.locator(".document-row .doc-main b")).toHaveText([
    "Декабрьский документ",
  ]);
  await page
    .getByRole("button", { name: "Следующий месяц", exact: true })
    .click();
  await expect(month).toContainText("Январь 2027");
  await expect(page.locator(".document-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Текущий месяц", exact: true })
    .click();
  await expect(month).toContainText("Ноябрь 2026");
  await expect(page.locator(".document-row")).toHaveCount(3);
  await chooseMonth(page, "Все месяцы");
  await expect(page.locator(".document-row")).toHaveCount(6);
  await home();
  await expect(page.locator(".stat-primary strong")).toHaveText(
    String(state.documents.filter((d) => !d.deleted).length),
  );
  await chooseMonth(page, "Ноябрь 2026");
  await page
    .locator(".category-card")
    .filter({ hasText: "Журналы индивидуальной работы" })
    .click();
  await expect(page.locator(".document-row")).toHaveCount(1);
  await page
    .locator("nav")
    .getByRole("button", { name: "История", exact: true })
    .click();
  await expect(month).toHaveCount(0);
  await expect(page.locator(".audit-list")).toContainText(
    "Октябрьский документ",
  );
  await home();
  await expect(month).toContainText("Ноябрь 2026");
  expect(app.store.documents()).toEqual(before);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
test("empty and distant months remain selectable, and saved cards open their deadline month", async ({
  page,
  recurringApp: app,
}) => {
  monthDocuments(app);
  await login(page, app, false);
  const month = page.getByRole("combobox", {
    name: "Месяц документов",
    exact: true,
  });
  await chooseMonth(page, "Февраль 2028");
  await expect(page.locator(".stat-primary strong")).toHaveText("1");
  await page
    .getByRole("button", { name: "Следующий месяц", exact: true })
    .click();
  await expect(month).toContainText("Март 2028");
  await expect(page.locator(".stat-primary strong")).toHaveText("0");
  await page
    .locator(".category-card")
    .filter({ hasText: "Планы основных культурно-досуговых мероприятий" })
    .click();
  await expect(page.locator(".document-row")).toHaveCount(0);
  const saveNew = async (title, due) => {
    await page
      .getByRole("button", { name: "Создать документ", exact: true })
      .click();
    await page.getByLabel("Название", { exact: true }).fill(title);
    await page.getByLabel("Срок предоставления").fill(due);
    await page
      .getByRole("button", { name: "Сохранить документ", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  };
  await saveNew("Карточка другого месяца", "2030-01-10");
  await expect(month).toContainText("Январь 2030");
  await expect(page.locator(".document-row .doc-main b")).toHaveText([
    "Карточка другого месяца",
  ]);
  await page.locator(".document-row").getByRole("button").click();
  await page
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page.getByLabel("Срок предоставления").fill("2030-02-10");
  await page
    .getByRole("button", { name: "Сохранить документ", exact: true })
    .click();
  await expect(month).toContainText("Февраль 2030");
  await expect(page.locator(".document-row .doc-main b")).toHaveText([
    "Карточка другого месяца",
  ]);
  await page
    .getByRole("button", { name: "Предыдущий месяц", exact: true })
    .click();
  await expect(month).toContainText("Январь 2030");
  await expect(page.locator(".document-row")).toHaveCount(0);
  await chooseMonth(page, "Все месяцы");
  await saveNew("Карточка в общем списке", "2031-01-10");
  await expect(month).toContainText("Все месяцы");
  await expect(
    page
      .locator(".document-row")
      .filter({ hasText: "Карточка в общем списке" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Текущий месяц", exact: true })
    .click();
  await expect(month).toContainText("Ноябрь 2026");
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
});
test("default month follows Moscow midnight while explicit periods survive refresh and reset on login", async ({
  page,
  recurringApp: app,
}) => {
  app.store.clock = () => new Date("2026-11-30T20:59:00Z");
  await login(page, app, false);
  const month = page.getByRole("combobox", {
    name: "Месяц документов",
    exact: true,
  });
  await expect(month).toContainText("Ноябрь 2026");
  app.store.clock = () => new Date("2026-11-30T21:00:00Z");
  await expect(month).toContainText("Декабрь 2026");
  await chooseMonth(page, "Ноябрь 2026");
  app.store.clock = () => new Date("2026-12-31T21:00:00Z");
  await expect(page.locator(".topbar-meta time")).toContainText("1 янв. 2027");
  await expect(month).toContainText("Ноябрь 2026");
  await page
    .getByRole("button", { name: "Текущий месяц", exact: true })
    .click();
  await expect(month).toContainText("Январь 2027");
  await chooseMonth(page, "Все месяцы");
  app.store.clock = () => new Date("2027-01-31T21:00:00Z");
  await expect(page.locator(".topbar-meta time")).toContainText("1 февр. 2027");
  await expect(month).toContainText("Все месяцы");
  await page
    .getByRole("button", { name: "Сменить аккаунт", exact: true })
    .click();
  await page.getByRole("button", { name: /Анна Смирнова/ }).click();
  await expect(month).toContainText("Февраль 2027");
});
test("branded category picker preserves a draft, supports keyboard search and selects the GDP category", async ({
  page,
  recurringApp: app,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 844 });
  await login(page, app);
  await page
    .getByRole("button", { name: "Создать документ", exact: true })
    .click();
  await page.getByLabel("Название", { exact: true }).fill("Черновик рапорта");
  await page
    .getByLabel("Срок предоставления", { exact: true })
    .fill("2026-11-16");
  const combo = page.getByRole("combobox", { name: "Категория", exact: true });
  await combo.click();
  await expect(combo).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: 320, height: 760 });
  await expect
    .poll(
      async () =>
        (await page.locator(".category-select-popup").boundingBox()).width,
    )
    .toBeLessThanOrEqual(296);
  const search = page.getByRole("textbox", {
    name: "Поиск в списке категорий",
    exact: true,
  });
  await search.fill("НЕСУЩЕСТВУЮЩАЯ");
  await expect(
    page.getByText("Категории не найдены", { exact: true }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(combo).toBeFocused();
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue(
    "Черновик рапорта",
  );
  await combo.press("ArrowDown");
  await page
    .getByRole("textbox", { name: "Поиск в списке категорий", exact: true })
    .fill("рапорт");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "Поиск в списке категорий", exact: true })
    .press("Enter");
  await expect(combo).toContainText("Рапорт ГДП");
  await expect(page.getByRole("dialog")).toBeVisible();
  await combo.click();
  await page
    .getByRole("textbox", { name: "Поиск в списке категорий", exact: true })
    .press("Tab");
  await expect(
    page.getByRole("button", { name: "Сохранить документ", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Сохранить документ", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const state = await (await page.request.get(app.url + "/api/state")).json();
  expect(
    state.documents.find((d) => d.title === "Черновик рапорта").categoryId,
  ).toBe("category-12");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});
test("weekly GDP report is submitted with dedicated labels in its card, table and history", async ({
  page,
  recurringApp: app,
}) => {
  await login(page, app);
  await page
    .locator(".category-card")
    .filter({ hasText: "Рапорт ГДП" })
    .click();
  await page
    .locator(".document-row")
    .getByRole("button", { name: /Рапорт ГДП/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Сдать до", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Вложен в журнал", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Сдан", exact: true }).click();
  await page
    .getByLabel("Фактическая дата сдачи", { exact: true })
    .fill("2026-11-09");
  await dialog.getByRole("button", { name: "Сдан", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .locator(".document-row")
    .getByRole("button", { name: /Рапорт ГДП/ })
    .click();
  await expect(dialog.locator(".badge")).toHaveText("Сдан");
  await expect(
    dialog.locator(".audit-event b").filter({ hasText: "Рапорт сдан" }),
  ).toBeVisible();
  await expect(dialog.locator(".deadline.on-time")).toHaveCount(2);
  await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "Таблица", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Категория в таблице", exact: true })
    .click();
  await page.getByRole("option", { name: "Рапорт ГДП", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "Сдать до", exact: true }),
  ).toBeVisible();
  await expect(page.locator("tbody .badge")).toHaveText("Сдан");
  await expect(page.locator("tbody")).toContainText("Сдан в срок");
});
test("summary cards open the correct table, filters match state and manual records remain available", async ({
  page,
  recurringApp: app,
}) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await login(page, app);
  await mutate(page, app, "/documents", {
    title: "Документ с прошедшим сроком",
    categoryId: "category-2",
    dueDate: "2020-01-01",
  });
  const state = await (await page.request.get(app.url + "/api/state")).json();
  const d = state.documents.find((d) => d.recurring?.ruleId === "monthly-vpr");
  await mutate(page, app, `/documents/${d.id}/actions/place`, {
    version: d.version,
    date: "2026-11-15",
  });
  const ready = state.documents.find(
    (d) => d.recurring?.ruleId === "weekly-summary",
  );
  await mutate(page, app, `/documents/${ready.id}/actions/ready`, {
    version: ready.version,
    date: "2026-11-13",
  });
  const docs = (await (await page.request.get(app.url + "/api/state")).json())
    .documents;
  for (const [label, key, count] of [
    ["Всего документов", "all", docs.length],
    [
      "В работе",
      "working",
      docs.filter((d) => !d.deleted && d.status === "IN_PROGRESS").length,
    ],
    ["Документ оформлен", "ready", 1],
    ["Просрочено без вложения", "overdue", 2],
    ["Завершено", "completed", 1],
  ]) {
    await page
      .locator("nav")
      .getByRole("button", { name: "Обзор", exact: true })
      .click();
    await page.locator(".stat").filter({ hasText: label }).click();
    await expect(
      page.getByRole("heading", { name: "Таблица документов" }),
    ).toBeVisible();
    await expect(
      page
        .locator(".dashboard-tabs")
        .getByRole("button", { name: new RegExp(label) }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("tbody tr")).toHaveCount(count);
    if (key === "working") {
      await expect(page.locator("tbody .badge")).toHaveText(
        Array(count).fill("В работе"),
      );
    }
  }
  await page
    .locator(".dashboard-tabs")
    .getByRole("button", { name: /^В работе/ })
    .click();
  await page
    .getByRole("combobox", { name: "Категория в таблице", exact: true })
    .click();
  await page
    .getByRole("option", {
      name: /^Планы основных культурно-досуговых мероприятий/,
    })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Поиск документов в таблице").fill("НЕ НАЙДЕНО");
  await expect(
    page.getByText("Документов по выбранным условиям нет"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
test("branded controls sort records, filter history and periods, and preserve settings drafts", async ({
  page,
  recurringApp: app,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, app);
  const alpha = await mutate(page, app, "/documents", {
    title: "Фильтр Альфа",
    categoryId: "category-2",
    readyDueDate: "2026-11-13",
    dueDate: "2026-11-20",
  });
  await mutate(page, app, "/documents", {
    title: "Фильтр Ясень",
    categoryId: "category-2",
    readyDueDate: "2026-11-17",
    dueDate: "2026-11-18",
  });
  await mutate(page, app, `/documents/${alpha.id}/actions/ready`, {
    version: alpha.version,
    date: "2026-11-13",
  });
  const nav = (name) =>
    page.locator("nav").getByRole("button", { name, exact: true }).click();
  const pick = async (label, name) => {
    const combo = page.getByRole("combobox", { name: label, exact: true });
    await combo.click();
    await expect(combo).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".category-select-popup")).toHaveCSS(
      "background-color",
      "rgb(0, 63, 56)",
    );
    await expect
      .poll(async () => {
        const a = await combo.boundingBox(),
          b = await page.locator(".category-select-popup").boundingBox();
        return Math.min(
          Math.abs(a.y - (b.y + b.height)),
          Math.abs(b.y - (a.y + a.height)),
        );
      })
      .toBeLessThanOrEqual(7);
    await page
      .getByRole("textbox", { name: `Поиск: ${label}`, exact: true })
      .fill(name);
    await page.getByRole("option", { name, exact: true }).click();
    await expect(combo).toHaveAttribute("aria-expanded", "false");
    await expect(combo).toContainText(name);
  };
  await nav("Таблица");
  await page.getByLabel("Поиск документов в таблице").fill("Фильтр");
  await expect(page.locator("tbody .table-title")).toHaveText([
    "Фильтр Ясень",
    "Фильтр Альфа",
  ]);
  await pick("Порядок в таблице", "По сроку оформления");
  await expect(page.locator("tbody .table-title")).toHaveText([
    "Фильтр Альфа",
    "Фильтр Ясень",
  ]);
  const order = page.getByRole("combobox", {
    name: "Порядок в таблице",
    exact: true,
  });
  await order.press("ArrowDown");
  await page
    .getByRole("textbox", { name: "Поиск: Порядок в таблице", exact: true })
    .fill("названию");
  await page
    .getByRole("textbox", { name: "Поиск: Порядок в таблице", exact: true })
    .press("Enter");
  await expect(order).toContainText("По названию");
  await expect(order).toBeFocused();
  await expect(page.locator("select")).toHaveCount(0);
  await nav("Обзор");
  await page
    .locator(".category-card")
    .filter({ hasText: "Планы основных культурно-досуговых мероприятий" })
    .click();
  await pick("Статус", "Документ оформлен");
  await expect(page.locator(".document-row")).toHaveCount(1);
  await pick("Срок", "Срок впереди");
  await expect(page.locator(".document-row")).toHaveCount(1);
  await expect(page.locator("select")).toHaveCount(0);
  await nav("История");
  await pick("Карточка в истории", "Фильтр Альфа");
  await pick("Участник в истории", "Анна Смирнова");
  await pick("Тип события", "Документ оформлен");
  await expect(page.locator(".audit-event")).toHaveCount(1);
  await expect(page.locator(".audit-event")).toContainText("Фильтр Альфа");
  const actor = page.getByRole("combobox", {
    name: "Участник в истории",
    exact: true,
  });
  await actor.click();
  const search = page.getByRole("textbox", {
    name: "Поиск: Участник в истории",
    exact: true,
  });
  await search.fill("НЕСУЩЕСТВУЮЩИЙ");
  await expect(
    page.getByText("Ничего не найдено", { exact: true }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(actor).toBeFocused();
  await expect(actor).toContainText("Анна Смирнова");
  await expect(page.locator("select")).toHaveCount(0);
  await nav("Проверки");
  const period = page.getByRole("combobox", { name: "Период", exact: true });
  await period.click();
  const periodName = await page.getByRole("option").nth(1).innerText();
  await page.getByRole("option").nth(1).click();
  await expect(period).toContainText(periodName);
  await expect(page.locator(".review-meta")).toContainText("11 дек. 2026");
  await expect(page.locator("select")).toHaveCount(0);
  await nav("Управление");
  const rule = page
    .locator(".rule-details")
    .filter({ hasText: "Боевой листок" });
  await rule.locator("summary").click();
  await pick("Оформление: Боевой листок", "Пятница");
  await rule
    .getByRole("button", {
      name: "Сохранить расписание документа",
      exact: true,
    })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (await page.request.get(app.url + "/api/state")).json()
        ).recurringRules.find((r) => r.id === "weekly-battle").ready_day,
    )
    .toBe(5);
  await page
    .locator(".panel")
    .filter({
      has: page.getByRole("heading", { name: "Участники и роли", exact: true }),
    })
    .getByRole("button", { name: "Добавить", exact: true })
    .click();
  await page.getByLabel("Имя", { exact: true }).fill("Синтетический черновик");
  await pick("Рабочая роль", "Начальник");
  await expect(page.getByLabel("Имя", { exact: true })).toHaveValue(
    "Синтетический черновик",
  );
  await pick("Новый администратор", "Иван Петров");
  await expect(
    page.getByRole("button", {
      name: "Передать администрирование",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.locator("select")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
});
for (const [categoryId, categoryName, submission] of [
  ["category-2", "Планы основных культурно-досуговых мероприятий", false],
  ["category-12", "Рапорт ГДП", true],
  ["category-6", "Материалы единых дней информирования", false],
  ["category-8", "Журнал доведения статей Уголовного кодекса", false],
]) {
  test(`readiness for ${categoryId} is prominent and counted independently through the ${submission ? "GDP submission" : "journal placement"} lifecycle`, async ({
    page,
    recurringApp: app,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, app);
    const readyLabel =
      categoryId === "category-6"
        ? "Лекторий проведен"
        : categoryId === "category-8"
          ? "Доведена"
          : "Документ оформлен";
    const dateLabel =
      categoryId === "category-6"
        ? "проведения"
        : categoryId === "category-8"
          ? "доведения"
          : "оформления";
    const countLabel =
      categoryId === "category-6"
        ? "Проведено"
        : categoryId === "category-8"
          ? "Доведено"
          : "Оформлено";
    const title = "Проверка статуса оформления";
    const create = (name) =>
      mutate(page, app, "/documents", {
        title: name,
        categoryId,
        readyDueDate: "2026-11-13",
        dueDate: "2026-11-14",
      });
    let doc = await create(title);
    let completed = await create("Уже завершённый документ");
    completed = await mutate(
      page,
      app,
      `/documents/${completed.id}/actions/ready`,
      { version: completed.version, date: "2026-11-13" },
    );
    await mutate(page, app, `/documents/${completed.id}/actions/place`, {
      version: completed.version,
      date: "2026-11-14",
    });
    let deleted = await create("Удалённый оформленный документ");
    deleted = await mutate(
      page,
      app,
      `/documents/${deleted.id}/actions/ready`,
      { version: deleted.version, date: "2026-11-13" },
    );
    await mutate(
      page,
      app,
      `/documents/${deleted.id}`,
      {
        version: deleted.version,
        confirmed: true,
      },
      "delete",
    );

    const home = () =>
      page
        .locator("nav")
        .getByRole("button", { name: "Обзор", exact: true })
        .click();
    const readyStat = page.locator(".stat-ready");
    await expect(readyStat.locator("strong")).toHaveText("0");
    await page
      .locator(".category-card")
      .filter({ hasText: categoryName })
      .click();
    const row = page.locator(".document-row").filter({ hasText: title });
    await row.getByRole("button").click();
    const dialog = page.getByRole("dialog");
    const readyButton = dialog.getByRole("button", {
      name: readyLabel,
      exact: true,
    });
    await expect(readyButton).toHaveClass(/ready-action/);
    await readyButton.click();
    await page
      .getByLabel(`Фактическая дата ${dateLabel}`, { exact: true })
      .fill("2026-11-13");
    await readyButton.click();
    await expect(dialog).not.toBeVisible();
    await expect(row.locator(".badge.ready")).toHaveText(readyLabel);
    const hint = submission ? "Ожидает сдачи" : "Ожидает вложения в журнал";
    await expect(row.locator(".status-hint")).toHaveText(hint);
    await expect(row.locator(".ready-date")).toContainText("13 нояб. 2026");
    await expect(row.locator(".deadline.overdue")).toBeVisible();
    await row.getByRole("button").click();
    await expect(dialog.locator(".readiness-note")).toContainText(readyLabel);
    await expect(dialog.locator(".readiness-note")).toContainText(hint);
    await expect(dialog.locator(".readiness-note")).toContainText(
      "13 нояб. 2026",
    );
    await expect(dialog.locator(".audit-ready")).toContainText(
      `Дата ${dateLabel}: — → 2026-11-13`,
    );
    await page
      .getByRole("button", { name: "Закрыть окно", exact: true })
      .click();

    await home();
    await expect(readyStat.locator("strong")).toHaveText("1");
    await expect(
      page
        .locator(".category-card")
        .filter({ hasText: categoryName })
        .locator(".category-ready-count"),
    ).toHaveText(`${countLabel}: 1`);
    await readyStat.click();
    const readyTab = page.locator(".dashboard-tabs .tab-ready");
    await expect(readyTab).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody .badge.ready")).toHaveText(readyLabel);
    await expect(page.locator("tbody .status-hint")).toHaveText(hint);
    await expect(page.locator("tbody .ready-date")).toContainText(
      "13 нояб. 2026",
    );
    await expect(page.locator("tbody .deadline.overdue")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Категория в таблице", exact: true })
      .click();
    await page.getByRole("option", { name: categoryName }).click();
    await expect(readyTab).toContainText(readyLabel);
    await expect(
      page.getByRole("columnheader", {
        name:
          categoryId === "category-6"
            ? "Провести до"
            : categoryId === "category-8"
              ? "Довести до"
              : "Оформить до",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("Поиск документов в таблице").fill("НЕ НАЙДЕНО");
    await expect(page.locator("tbody tr")).toHaveCount(0);
    await page
      .getByLabel("Поиск документов в таблице")
      .fill("Проверка статуса");
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await page.locator(".dashboard-tabs .tab-overdue").click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody .badge.ready")).toHaveText(readyLabel);
    await page
      .locator("nav")
      .getByRole("button", { name: "Проверки", exact: true })
      .click();
    await expect(page.locator(".summary-ready b")).toHaveText("1");
    await expect(page.locator(".summary-ready span")).toHaveText(
      "Документ оформлен",
    );

    await home();
    await page
      .locator(".category-card")
      .filter({ hasText: categoryName })
      .click();
    await page.getByRole("combobox", { name: "Статус", exact: true }).click();
    await page.getByRole("option", { name: readyLabel, exact: true }).click();
    await expect(page.locator(".document-row")).toHaveCount(1);
    await row.getByRole("button").click();
    const delivery = submission ? "Сдан" : "Вложен в журнал";
    await dialog.getByRole("button", { name: delivery, exact: true }).click();
    await page
      .getByLabel(
        submission ? "Фактическая дата сдачи" : "Фактическая дата вложения",
        { exact: true },
      )
      .fill("2026-11-14");
    await dialog.getByRole("button", { name: delivery, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".document-row")).toHaveCount(0);
    await home();
    await expect(readyStat.locator("strong")).toHaveText("0");
    await readyStat.click();
    await expect(page.locator("tbody tr")).toHaveCount(0);

    const current = async () =>
      (
        await (await page.request.get(app.url + "/api/state")).json()
      ).documents.find((d) => d.id === doc.id);
    doc = await current();
    doc = await mutate(page, app, `/documents/${doc.id}/actions/return`, {
      version: doc.version,
      reason: "Уточнение документа",
      confirmed: true,
    });
    doc = await mutate(page, app, `/documents/${doc.id}/actions/ready`, {
      version: doc.version,
      date: "2026-11-13",
    });
    await expect(page.locator("tbody tr")).toHaveCount(1);
    doc = await mutate(page, app, `/documents/${doc.id}/actions/return`, {
      version: doc.version,
      reason: "Повторное уточнение",
      confirmed: true,
    });
    await expect(page.locator("tbody tr")).toHaveCount(0);
    await home();
    await expect(readyStat.locator("strong")).toHaveText("0");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  });
}
test("monthly conversation group stays one card, edits names and requires forty real readiness marks before placement", async ({
  page,
  recurringApp: app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, app);
  await page
    .locator(".category-card")
    .filter({ hasText: "Журналы индивидуальной работы" })
    .click();
  await page
    .locator(".document-row")
    .getByRole("button", { name: /Лист беседы/ })
    .click();
  const rows = page.locator(".subdocument-row");
  await expect(rows).toHaveCount(40);
  await expect(
    page.getByRole("button", { name: "Вложен в журнал", exact: true }),
  ).toBeDisabled();
  await rows
    .first()
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await page
    .getByLabel("Название листа: Лист беседы №1", { exact: true })
    .fill("Рядовой Тестовый");
  await page
    .getByRole("button", { name: "Сохранить название", exact: true })
    .click();
  await expect(rows.first()).toContainText("Рядовой Тестовый");
  await rows.first().getByRole("checkbox").check();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  const doc = (
    await (await page.request.get(app.url + "/api/state")).json()
  ).documents.find((d) => d.categoryId === "category-9");
  const markAll = page.getByRole("button", {
    name: "Отметить все 40 листов",
    exact: true,
  });
  await expect(markAll).toBeEnabled();
  await page.route(
    "**/api/documents/*/items/complete",
    (route) => route.abort("failed"),
    { times: 1 },
  );
  await markAll.click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Нет связи с сервером",
  );
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(markAll).toBeEnabled();
  await markAll.click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "40");
  await expect(rows.locator('input[type="checkbox"]:checked')).toHaveCount(40);
  await expect(markAll).toBeDisabled();
  const marked = (
    await (await page.request.get(app.url + "/api/state")).json()
  ).documents.find((d) => d.id === doc.id);
  expect(marked.items.every((item) => !!item.ready)).toBe(true);
  expect(marked.items[0]).toEqual(doc.items[0]);
  expect(marked.status).toBe("READY");
  expect(marked.completed).toBe(false);
  expect(marked.placement).toBeNull();
  await expect(
    page
      .locator(".audit-event")
      .filter({ hasText: "Все листы беседы отмечены" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Вложен в журнал", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Вложен в журнал", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .locator(".document-row")
    .getByRole("button", { name: /Лист беседы/ })
    .click();
  await expect(page.locator(".completion-note")).toContainText(
    "Документ завершён",
  );
  await expect(rows.first().getByRole("checkbox")).toBeDisabled();
  await expect(markAll).toHaveCount(0);
  const state = await (await page.request.get(app.url + "/api/state")).json();
  expect(
    state.documents.filter((d) => d.categoryId === "category-9"),
  ).toHaveLength(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
test("Tuesday default and empty lecture topics can be edited directly and scheduler controls still save", async ({
  page,
  recurringApp: app,
}) => {
  await login(page, app);
  await page
    .locator("nav")
    .getByRole("button", { name: "Таблица", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /План проведения военно-политического информирования/,
    })
    .click();
  await expect(page.locator(".document-topic-detail")).toContainText(
    "Военно-политическая (общественно-политическая) обстановка",
  );
  await page
    .getByRole("button", { name: "Изменить тему", exact: true })
    .click();
  await expect(
    page.getByLabel("Тема лектория", { exact: true }),
  ).toBeEditable();
  await expect(page.getByLabel("Тема лектория", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Название", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("Тема лектория", { exact: true })
    .fill("Уточнённая тема вторника");
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  await expect(page.locator(".document-topic-detail")).toContainText(
    "Уточнённая тема вторника",
  );
  await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  await page
    .getByRole("button", { name: /План проведения воскресного лектория/ })
    .click();
  await expect(page.locator(".document-topic-detail")).toContainText(
    "Тема пока не указана.",
  );
  await page.getByRole("button", { name: "Указать тему", exact: true }).click();
  await expect(page.getByLabel("Тема лектория", { exact: true })).toHaveValue(
    "",
  );
  await page.getByLabel("Тема лектория").fill("История научной роты");
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  await expect(page.locator(".document-topic-detail")).toContainText(
    "История научной роты",
  );
  await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  await page
    .getByLabel("Поиск документов в таблице")
    .fill("История научной роты");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .locator("nav")
    .getByRole("button", { name: "Управление", exact: true })
    .click();
  const rule = page
    .locator(".rule-details")
    .filter({ hasText: "Боевой листок" });
  await rule.locator("summary").click();
  await rule
    .getByRole("checkbox", { name: "Создавать автоматически" })
    .uncheck();
  await rule
    .getByRole("button", {
      name: "Сохранить расписание документа",
      exact: true,
    })
    .click();
  await expect(rule.locator("summary")).toContainText("выключено");
});
test("manual Tuesday plans prefill a default while other lecture types start empty", async ({
  page,
  recurringApp: app,
}) => {
  await login(page, app);
  await page
    .locator(".category-card")
    .filter({ hasText: "Материалы единых дней информирования" })
    .click();
  await page
    .getByRole("button", { name: "Создать документ", exact: true })
    .click();
  const title = page.getByLabel("Название", { exact: true }),
    topic = page.getByLabel("Тема лектория", { exact: true });
  await expect(topic).toHaveValue("");
  await title.fill("План проведения воскресного лектория");
  await expect(topic).toHaveValue("");
  await title.fill("План проведения военно-политического информирования");
  await expect(topic).toHaveValue(
    app.store.recurringRules().find((r) => r.id === "inform-tuesday").topic,
  );
  await topic.fill("Тема, введённая вручную");
  await page.getByLabel("Срок предоставления").fill("2026-11-30");
  await page
    .getByRole("button", { name: "Сохранить документ", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const manual = app.store
    .documents()
    .find(
      (d) => d.title === "План проведения военно-политического информирования",
    );
  expect(manual.topic).toBe("Тема, введённая вручную");
  expect(manual.recurring).toBeNull();
  await page
    .getByRole("button", { name: "Создать документ", exact: true })
    .click();
  await title.fill(
    "План проведения военно-политической работы в вечернее время",
  );
  await expect(topic).toHaveValue("");
  await title.fill("План проведения единого дня информирования");
  await expect(topic).toHaveValue("");
});
test("quick topic editing preserves completion and handles stale versions without discarding the draft", async ({
  page,
  recurringApp: app,
}) => {
  const created = app.store.create(app.store.user("worker-1"), {
    title: "План с подтверждением",
    categoryId: "category-6",
    dueDate: "2026-11-30",
    topic: "Прежняя тема",
  });
  const original = app.store.action(
    app.store.user("chief-1"),
    created.id,
    "place-confirm",
    { version: created.version, date: "2026-11-15" },
  );
  await login(page, app);
  await page
    .locator(".category-card")
    .filter({ hasText: "Материалы единых дней информирования" })
    .click();
  await page
    .locator(".document-row")
    .getByRole("button", { name: /План с подтверждением/ })
    .click();
  await page
    .getByRole("button", { name: "Изменить тему", exact: true })
    .click();
  const topic = page.getByLabel("Тема лектория", { exact: true });
  await topic.fill("Новая тема");
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  expect(app.store.document(original.id)).toEqual(original);
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  await expect(page.locator(".document-topic-detail")).toContainText(
    "Новая тема",
  );
  await expect(page.getByRole("dialog").locator(".badge")).toHaveText(
    "Вложен в журнал",
  );
  const completed = app.store.document(original.id);
  expect(completed.placement).toEqual(original.placement);
  expect(completed.confirmation).toBeNull();
  await page
    .getByRole("button", { name: "Изменить тему", exact: true })
    .click();
  await topic.fill("Мой черновик");
  await mutate(
    page,
    app,
    `/documents/${original.id}`,
    {
      version: completed.version,
      title: "Название от другого участника",
      categoryId: completed.categoryId,
      dueDate: completed.dueDate,
    },
    "patch",
  );
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Карточка изменена другим участником",
  );
  await expect(topic).toHaveValue("Мой черновик");
  await page
    .getByRole("button", { name: "Загрузить актуальную карточку", exact: true })
    .click();
  await expect(topic).toHaveValue("Новая тема");
  await topic.fill("Мой черновик");
  await page
    .getByRole("button", { name: "Сохранить тему", exact: true })
    .click();
  await expect(page.locator(".document-topic-detail")).toContainText(
    "Мой черновик",
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", {
        name: "Название от другого участника",
        exact: true,
      }),
  ).toBeVisible();
  await expect(
    page.locator(".audit-event").filter({ hasText: "Тема лектория:" }).first(),
  ).toContainText("Мой черновик");
});
