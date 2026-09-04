import { expect, test, type Page } from "@playwright/test";
import { addShoppingItem, openFreshKitchen, openShopping, persistedUpdateCount } from "./helpers";

test.skip(({ browserName }) => browserName === "webkit", "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");

async function ensureServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

async function expectConnected(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Share kitchen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Share kitchen" })).toBeVisible();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close share kitchen" }).click();
  await expect(page.getByRole("dialog", { name: "Share kitchen" })).toHaveCount(0);
}

test("an offline tick survives an immediate reload after IndexedDB persists it", async ({ page, context }) => {
  const id = await openFreshKitchen(page);
  await openShopping(page);
  await addShoppingItem(page, "offline parsley");
  await ensureServiceWorkerControl(page);

  await context.setOffline(true);
  try {
    const beforeTick = await persistedUpdateCount(page, id);
    const item = page.getByRole("checkbox", { name: "offline parsley" });
    await page.getByText("offline parsley", { exact: true }).click();
    await expect(item).toBeChecked();
    await expect.poll(() => persistedUpdateCount(page, id)).toBeGreaterThan(beforeTick);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("checkbox", { name: "offline parsley" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "offline parsley" })).toBeChecked();
  } finally {
    await context.setOffline(false);
  }
});

test("two shoppers edit offline, reload, reconnect in either order, and retain the merge", async ({ page, context, browser }) => {
  const id = await openFreshKitchen(page);
  await openShopping(page);
  await addShoppingItem(page, "market apples");
  await addShoppingItem(page, "market bread");
  await ensureServiceWorkerControl(page);

  const secondContext = await browser.newContext();
  let second = await secondContext.newPage();
  try {
    await second.goto(page.url());
    await expect(second.getByRole("checkbox", { name: "market apples" })).toBeVisible();
    await expect(second.getByRole("checkbox", { name: "market bread" })).toBeVisible();
    await ensureServiceWorkerControl(second);

    await context.setOffline(true);
    await secondContext.setOffline(true);

    const firstCount = await persistedUpdateCount(page, id);
    const secondCount = await persistedUpdateCount(second, id);
    await page.getByText("market apples", { exact: true }).click();
    await second.getByText("market bread", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "market apples" })).toBeChecked();
    await expect(second.getByRole("checkbox", { name: "market bread" })).toBeChecked();
    await expect.poll(() => persistedUpdateCount(page, id)).toBeGreaterThan(firstCount);
    await expect.poll(() => persistedUpdateCount(second, id)).toBeGreaterThan(secondCount);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("checkbox", { name: "market apples" })).toBeChecked();
    await second.reload({ waitUntil: "domcontentloaded" });
    await expect(second.getByRole("checkbox", { name: "market bread" })).toBeChecked();

    await secondContext.setOffline(false);
    await expectConnected(second);
    await context.setOffline(false);
    await expectConnected(page);

    for (const current of [page, second]) {
      await expect.poll(() => current.getByRole("checkbox", { name: "market apples" }).isChecked()).toBe(true);
      await expect.poll(() => current.getByRole("checkbox", { name: "market bread" }).isChecked()).toBe(true);
    }

    const kitchenUrl = page.url();
    await page.close();
    await second.close();
    page = await context.newPage();
    second = await secondContext.newPage();
    await page.goto(kitchenUrl);
    await second.goto(kitchenUrl);
    for (const current of [page, second]) {
      await expect(current.getByRole("checkbox", { name: "market apples" })).toBeChecked();
      await expect(current.getByRole("checkbox", { name: "market bread" })).toBeChecked();
    }
  } finally {
    await context.setOffline(false);
    await secondContext.setOffline(false);
    await secondContext.close();
  }
});
