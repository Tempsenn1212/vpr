import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createApp } from "../../server/app.mjs";
const test = base.extend({
  roleApp: async ({}, use) => {
    const app = createApp({
      database: ":memory:",
      demo: true,
      production: false,
      seed: false,
      automation: false,
      clock: () => new Date("2026-11-27T12:00:00Z"),
    });
    app.store.create(app.store.user("worker-1"), {
      title: "Документ для оператора",
      categoryId: "category-2",
      dueDate: "2026-11-27",
    });
    const server = app.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    app.config.origin = `http://127.0.0.1:${server.address().port}`;
    try {
      await use({ ...app, url: app.config.origin });
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      app.db.close();
    }
  },
});
async function login(page, app, name = "Анна Смирнова") {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (r) =>
    r.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.goto(app.url);
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(
    page.getByRole("heading", { name: "Обзор документации" }),
  ).toBeVisible();
}
test("roles UI creates, assigns, renames and revokes rights on mobile while preserving the open participant session", async ({
  page,
  browser,
  roleApp: app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, app);
  await page
    .locator("nav")
    .getByRole("button", { name: "Управление", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Роли и права", exact: true });
  await panel
    .getByRole("button", { name: "Добавить роль", exact: true })
    .click();
  let form = page.getByRole("form", { name: "Настройка роли", exact: true });
  await form.getByLabel("Название роли", { exact: true }).fill("Оператор");
  await form
    .getByRole("checkbox", {
      name: "Отмечать оформление, проведение и доведение",
      exact: true,
    })
    .check();
  await form
    .getByRole("checkbox", {
      name: "Отмечать вложение в журнал и сдачу",
      exact: true,
    })
    .check();
  await form
    .getByRole("button", { name: "Сохранить роль", exact: true })
    .click();
  await expect(form).toHaveCount(0);
  const users = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "Участники и роли", exact: true }),
  });
  await users
    .locator(".management-row")
    .filter({ hasText: "Иван Петров" })
    .getByRole("button", { name: "Изменить", exact: true })
    .click();
  await users
    .getByRole("combobox", { name: "Рабочая роль", exact: true })
    .click();
  await page.getByRole("option", { name: "Оператор", exact: true }).click();
  await users
    .getByRole("button", { name: "Сохранить участника", exact: true })
    .click();
  await expect(
    users.locator(".management-row").filter({ hasText: "Иван Петров" }),
  ).toContainText("Оператор");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const worker = await context.newPage();
  try {
    await login(worker, app, "Иван Петров");
    await expect(
      worker.getByRole("button", { name: "Создать документ", exact: true }),
    ).toHaveCount(0);
    await expect(
      worker
        .locator("nav")
        .getByRole("button", { name: "Управление", exact: true }),
    ).toHaveCount(0);
    await worker
      .locator(".category-card")
      .filter({ hasText: "Планы основных культурно-досуговых" })
      .click();
    await worker
      .getByRole("button", { name: /Документ для оператора/ })
      .click();
    const dialog = worker.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Редактировать", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Документ оформлен", exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Документ оформлен", exact: true })
      .click();
    await worker
      .getByRole("dialog")
      .getByRole("button", { name: "Документ оформлен", exact: true })
      .click();
    await expect(worker.getByRole("dialog")).toHaveCount(0);
    await worker
      .getByRole("button", { name: /Документ для оператора/ })
      .click();
    await worker
      .getByRole("dialog")
      .getByRole("button", { name: "Вложен в журнал", exact: true })
      .click();
    await expect(
      worker
        .getByRole("dialog")
        .getByRole("heading", { name: "Вложен в журнал", exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "Изменить роль Оператор", exact: true })
      .click();
    form = page.getByRole("form", { name: "Настройка роли", exact: true });
    await form.getByLabel("Название роли", { exact: true }).fill("Наблюдатель");
    await form
      .getByRole("checkbox", {
        name: "Отмечать оформление, проведение и доведение",
        exact: true,
      })
      .uncheck();
    await form
      .getByRole("checkbox", {
        name: "Отмечать вложение в журнал и сдачу",
        exact: true,
      })
      .uncheck();
    await form
      .getByRole("button", { name: "Сохранить роль", exact: true })
      .click();
    await expect(worker.getByRole("dialog")).toHaveCount(0);
    expect(
      app.store.documents().find((d) => d.title === "Документ для оператора")
        .status,
    ).toBe("READY");
    await expect(
      worker
        .locator("nav")
        .getByRole("button", { name: "История", exact: true }),
    ).toHaveCount(0);
    await expect(
      worker
        .locator("nav")
        .getByRole("button", { name: "Проверки", exact: true }),
    ).toHaveCount(0);
    await worker
      .getByRole("button", { name: /Документ для оператора/ })
      .click();
    await expect(
      worker.getByRole("dialog").locator(".action-grid button"),
    ).toHaveCount(0);
    await expect(
      worker.getByRole("heading", { name: "История карточки", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    expect(
      await worker.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  } finally {
    await context.close();
  }
});
test("role editor preserves its draft on concurrent change and explicitly reloads the current name and permissions", async ({
  page,
  roleApp: app,
}) => {
  await login(page, app);
  await page
    .locator("nav")
    .getByRole("button", { name: "Управление", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Роли и права", exact: true });
  await panel
    .getByRole("button", { name: "Изменить роль Работник", exact: true })
    .click();
  const form = page.getByRole("form", { name: "Настройка роли", exact: true });
  await form.getByLabel("Название роли", { exact: true }).fill("Черновик");
  const role = app.store.roles().find((r) => r.id === "WORKER");
  const r = await page.request.patch(app.url + "/api/roles/WORKER", {
    data: { ...role, name: "Специалист" },
    headers: { "Idempotency-Key": randomUUID() },
  });
  expect(r.status()).toBe(200);
  await expect(
    form.getByRole("button", {
      name: "Загрузить актуальную роль",
      exact: true,
    }),
  ).toBeVisible();
  await expect(form.getByLabel("Название роли", { exact: true })).toHaveValue(
    "Черновик",
  );
  await form
    .getByRole("button", { name: "Сохранить роль", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Роль изменена другим участником",
  );
  await expect(form.getByLabel("Название роли", { exact: true })).toHaveValue(
    "Черновик",
  );
  await form
    .getByRole("button", { name: "Загрузить актуальную роль", exact: true })
    .click();
  await expect(form.getByLabel("Название роли", { exact: true })).toHaveValue(
    "Специалист",
  );
  await form
    .getByLabel("Название роли", { exact: true })
    .fill("Специалист роты");
  await form
    .getByRole("button", { name: "Сохранить роль", exact: true })
    .click();
  await expect(
    panel.getByRole("button", {
      name: "Изменить роль Специалист роты",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Переключить тему", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Изменить роль Специалист роты", exact: true })
    .click();
  await expect(form.getByLabel("Название роли", { exact: true })).toHaveValue(
    "Специалист роты",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
