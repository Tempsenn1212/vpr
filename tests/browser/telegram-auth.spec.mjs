import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
function initData(id) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: "Тест Telegram" }),
  });
  const check = [...params]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-e2e-bot-token")
    .digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}
async function telegram(page, id) {
  const data = initData(id);
  await page.route("https://telegram.org/js/telegram-web-app.js*", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `window.Telegram={WebApp:{initData:${JSON.stringify(data)},colorScheme:'light',ready(){},expand(){},onEvent(){},offEvent(){}}}`,
    }),
  );
  await page.route("**/api/config", (r) =>
    r.fulfill({ json: { demo: false, appName: "Учёт документации ВПР" } }),
  );
}

test("Telegram Web: signed login and document write work when browser receives no cookies", async ({
  page,
  request,
}) => {
  await telegram(page, 900000001);
  let authenticatedReads = 0;
  await page.route("**/api/auth/telegram", async (route) => {
    const response = await request.post(
      "http://localhost:4173/api/auth/telegram",
      { data: route.request().postDataJSON() },
    );
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: await response.text(),
    });
  });
  page.on("request", (r) => {
    if (
      r.url().endsWith("/api/state") &&
      r.headers().authorization?.startsWith("Bearer ")
    )
      authenticatedReads++;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Обзор документации" }),
  ).toBeVisible();
  expect(await page.context().cookies()).toHaveLength(0);
  await page.getByRole("button", { name: "Создать документ" }).click();
  const title = "Telegram Web без cookies " + Date.now();
  await page.getByLabel("Название", { exact: true }).fill(title);
  await page.getByLabel("Срок предоставления").fill("2026-11-27");
  await page.getByRole("button", { name: "Сохранить документ" }).click();
  await expect(page.getByRole("status")).toContainText("Карточка сохранена");
  await expect.poll(() => authenticatedReads).toBeGreaterThanOrEqual(2);
  expect(await page.context().cookies()).toHaveLength(0);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Обзор документации" }),
  ).toBeVisible();
});

test("Telegram login denial remains visible instead of being replaced by background session errors", async ({
  page,
}) => {
  await telegram(page, 777777777);
  let stateRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/state")) stateRequests++;
  });
  await page.goto("/");
  const reason = page.locator(".login-card p");
  await expect(reason).toContainText("Обратитесь к администратору");
  await page.waitForTimeout(2500);
  await expect(reason).toContainText("Обратитесь к администратору");
  expect(stateRequests).toBe(0);
});

test("missing Telegram SDK has a specific error and does not start unauthorized polling", async ({
  page,
}) => {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (r) =>
    r.abort(),
  );
  await page.route("**/api/config", (r) =>
    r.fulfill({ json: { demo: false, appName: "Учёт документации ВПР" } }),
  );
  let stateRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/state")) stateRequests++;
  });
  await page.goto("/");
  await expect(page.locator(".login-card p")).toContainText(
    "Не удалось загрузить Telegram SDK",
  );
  expect(stateRequests).toBe(0);
});
