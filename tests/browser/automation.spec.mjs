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
async function login(page, app) {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (r) =>
    r.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.goto(app.url);
  await page.getByRole("button", { name: /Анна Смирнова/ }).click();
  await expect(
    page.getByRole("heading", { name: "Обзор документации" }),
  ).toBeVisible();
}
async function mutate(page, app, path, body, method = "post") {
  const response = await page.request[method](app.url + "/api" + path, {
    data: body,
    headers: { "Idempotency-Key": randomUUID() },
  });
  expect(response.status()).toBe(200);
  return response.json();
}
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
test("Tuesday topic is fixed, Sunday topic is editable and scheduler controls save through the UI", async ({
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
    .getByRole("dialog")
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await expect(page.getByLabel("Тема лектория")).not.toBeEditable();
  await page.getByRole("button", { name: "Закрыть окно", exact: true }).click();
  await page
    .getByRole("button", { name: /План проведения воскресного лектория/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page.getByLabel("Тема лектория").fill("История научной роты");
  await page
    .getByRole("button", { name: "Сохранить документ", exact: true })
    .click();
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
