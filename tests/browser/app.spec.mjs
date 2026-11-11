import { test, expect } from "@playwright/test";
const login = async (page, name = "Анна Смирнова") => {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(
    page.getByRole("heading", { name: "Обзор документации" }),
  ).toBeVisible();
};
async function createUI(page, title) {
  await page.getByRole("button", { name: "Создать документ" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill(title);
  await dialog.getByLabel("Срок предоставления").fill("2026-11-27");
  await dialog.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(dialog).not.toBeVisible();
}
test("two clients: create appears within 5 seconds, worker cannot confirm, marks share authors", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const p1 = await a.newPage(),
    p2 = await b.newPage();
  await login(p1);
  await login(p2, "Иван Петров");
  await p1.locator(".category-card").filter({ hasText: "Иконка №1" }).click();
  await p2.locator(".category-card").filter({ hasText: "Иконка №1" }).click();
  const title = "Документ двух клиентов " + Date.now();
  await createUI(p1, title);
  await expect(p2.getByRole("button", { name: new RegExp(title) })).toBeVisible(
    { timeout: 5000 },
  );
  await p2.getByRole("button", { name: new RegExp(title) }).click();
  let dialog = p2.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Подтвердить вложение", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Документ оформлен", exact: true })
    .click();
  await p2
    .getByRole("dialog")
    .getByRole("button", { name: "Документ оформлен", exact: true })
    .click();
  await expect(p2.getByRole("dialog")).not.toBeVisible();
  await p1.getByRole("button", { name: new RegExp(title) }).click();
  dialog = p1.getByRole("dialog");
  await expect(
    dialog.locator(".marks").getByText("Иван Петров ·", { exact: false }),
  ).toBeVisible();
  await a.close();
  await b.close();
});
test("mobile: long title, form validation, placement, copy, soft deletion and dark theme", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await login(page);
  await page.locator(".category-card").filter({ hasText: "Иконка №2" }).click();
  await page.getByRole("button", { name: "Создать документ" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить документ" })
    .click();
  await expect(
    page.getByText("Введите название (1–200 символов)"),
  ).toBeVisible();
  await expect(page.getByText("Укажите срок", { exact: true })).toBeVisible();
  const title =
    "Очень длинное название документа для проверки переноса текста на мобильном экране " +
    Date.now();
  await page.getByLabel("Название", { exact: true }).fill(title);
  await page.getByLabel("Срок предоставления").fill("2026-11-27");
  await page.getByRole("button", { name: "Сохранить документ" }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Вложен в журнал", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Вложен в журнал", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Создать копию" })
    .click();
  await expect(page.getByLabel("Срок предоставления")).toHaveValue("");
  await page.getByLabel("Срок предоставления").fill("2026-12-11");
  await page.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(title) }),
  ).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await page.screenshot({
    path: "test-results/mobile-dark.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: new RegExp(title) })
    .last()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Удалить карточку", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(title) }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "История", exact: true }).click();
  await page.getByRole("checkbox", { name: "Только удалённые" }).check();
  await page
    .locator(".audit-list")
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await expect(
    page.getByRole("dialog").getByText("Карточка удалена · только просмотр"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Редактировать", exact: true }),
  ).toHaveCount(0);
  await context.close();
});
test("desktop chief: exclude selected card in category, review snapshot and history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, "Елена Соколова");
  await page
    .getByRole("button", { name: /Проверки/ })
    .first()
    .click();
  await page.getByLabel("Категория проверки").selectOption("category-1");
  const all = page.getByLabel("Выбрать все ожидающие");
  await all.check();
  const selected = page.locator(".document-row input:not([disabled])");
  const n = await selected.count();
  expect(n).toBeGreaterThan(0);
  await selected.first().uncheck();
  await expect(
    page.getByRole("button", {
      name: `Подтвердить выбранные (${n - 1})`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверка проведена", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Проверка проведена", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Проверка зафиксирована",
  );
  await page.screenshot({
    path: "test-results/desktop-reviews.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "История действий" }),
  ).toBeVisible();
  await expect(
    page.locator(".audit-event b").filter({ hasText: "Проверка проведена" }),
  ).toBeVisible();
});
test("network failure is visible and never reports false success; reconnect loads updates", async ({
  page,
}) => {
  await login(page);
  await page.locator(".category-card").filter({ hasText: "Иконка №3" }).click();
  await page.getByRole("button", { name: "Создать документ" }).click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("Не сохранён при сетевом сбое");
  await page.getByLabel("Срок предоставления").fill("2026-11-27");
  await page.route("**/api/**", (route) => route.abort());
  await page.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Нет связи",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText(/Связь потеряна/)).toBeVisible();
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: /Не сохранён при сетевом сбое/ }),
  ).toBeVisible();
});
test("empty results and light layout at 360px have no horizontal scroll", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 780 },
  });
  const p = await ctx.newPage();
  await login(p);
  await p.locator(".category-card").filter({ hasText: "Иконка №1" }).click();
  await p.getByPlaceholder("Поиск по названию").fill("НИЧЕГО_НЕ_НАЙДЕНО");
  await expect(
    p.getByRole("heading", { name: "Документов пока нет" }),
  ).toBeVisible();
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  ).toBe(false);
  await p.screenshot({ path: "test-results/mobile-empty.png", fullPage: true });
  await ctx.close();
});

test("stale form keeps draft and offers current server data instead of overwriting", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  const p1 = await a.newPage(),
    p2 = await b.newPage();
  await login(p1);
  await login(p2, "Иван Петров");
  await p1.locator(".category-card").filter({ hasText: "Иконка №1" }).click();
  await p2.locator(".category-card").filter({ hasText: "Иконка №1" }).click();
  const title = "Конфликт " + Date.now();
  await createUI(p1, title);
  await expect(p2.getByRole("button", { name: new RegExp(title) })).toBeVisible(
    { timeout: 5000 },
  );
  await p1.getByRole("button", { name: new RegExp(title) }).click();
  await p1
    .getByRole("dialog")
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await p1.getByLabel("Название", { exact: true }).fill(title + " черновик");
  await p2.getByRole("button", { name: new RegExp(title) }).click();
  await p2
    .getByRole("dialog")
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await p2
    .getByLabel("Название", { exact: true })
    .fill(title + " чужая правка");
  await p2.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(p2.getByRole("dialog")).not.toBeVisible();
  await p1.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(p1.getByRole("dialog").getByRole("alert")).toContainText(
    "Карточка изменена",
  );
  await expect(p1.getByLabel("Название", { exact: true })).toHaveValue(
    title + " черновик",
  );
  await p1
    .getByRole("button", { name: "Загрузить актуальную карточку" })
    .click();
  await expect(p1.getByLabel("Название", { exact: true })).toHaveValue(
    title + " чужая правка",
  );
  await a.close();
  await b.close();
});

test("administrator UI saves users, categories, schedule preview and preserves worker permissions", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Управление", exact: true }).click();
  await page.getByRole("button", { name: "Рассчитать ближайшие даты" }).click();
  await expect(
    page.getByRole("heading", { name: "Предварительный расчёт" }),
  ).toBeVisible();
  const users = page
    .locator(".panel")
    .filter({ has: page.getByRole("heading", { name: "Участники и роли" }) });
  await users.getByRole("button", { name: "Добавить", exact: true }).click();
  await users.getByLabel("Имя", { exact: true }).fill("Тестовый участник");
  await users.getByLabel("Telegram ID", { exact: true }).fill("900000099");
  await users.getByRole("button", { name: "Сохранить участника" }).click();
  await expect(
    users.getByText("Тестовый участник", { exact: true }),
  ).toBeVisible();
  const cats = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "Категории", exact: true }),
  });
  await cats.getByRole("button", { name: "Добавить", exact: true }).click();
  await cats.getByLabel("Название категории").fill("Новая категория");
  await cats.getByRole("button", { name: "Сохранить категорию" }).click();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await expect(
    page.locator(".category-card").filter({ hasText: "Новая категория" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Проверки/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: /Подтвердить выбранные/ }),
  ).toHaveCount(0);
});
