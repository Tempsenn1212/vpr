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
  const docs = (await (await page.request.get(app.url + "/api/state")).json())
    .documents;
  for (const [label, key, count] of [
    ["Всего документов", "all", docs.length],
    ["Просрочено без вложения", "overdue", 1],
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
  }
  await page
    .locator(".dashboard-tabs")
    .getByRole("button", { name: /Всего документов/ })
    .click();
  await page.getByLabel("Категория в таблице").selectOption("category-2");
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
  let doc = (
    await (await page.request.get(app.url + "/api/state")).json()
  ).documents.find((d) => d.categoryId === "category-9");
  for (const item of doc.items.slice(1))
    doc = await mutate(
      page,
      app,
      `/documents/${doc.id}/items/${item.id}`,
      { version: doc.version, done: true },
      "patch",
    );
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "40");
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
      name: /ПЛАН ПРОВЕДЕНИЯ ВОЕННО-ПОЛИТИЧЕСКОГО ИНФОРМИРОВАНИЯ/,
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
    .getByRole("button", { name: /ПЛАН ПРОВЕДЕНИЯ ВОСКРЕСНОГО ЛЕКТОРИЯ/ })
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
