import { expect, test, type Page } from "@playwright/test";

test.skip(({ browserName }) => browserName === "webkit", "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");

const KITCHEN_ID = /^[a-z2-7]{26}$/;

function kitchenIdFromPage(page: Page): string {
  const id = new URL(page.url()).hash.match(/^#k=([a-z2-7]{26})$/)?.[1] ?? "";
  expect(id).toMatch(KITCHEN_ID);
  return id;
}

async function openFreshKitchen(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page).toHaveURL(/#k=[a-z2-7]{26}$/);
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  return kitchenIdFromPage(page);
}

async function openShopping(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
}

async function addShoppingItem(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Add a shopping item").fill(item);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: item })).toBeVisible();
}

async function ensureServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

async function persistedUpdateCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (name) => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction("updates", "readonly").objectStore("updates").count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); reject(count.error); };
    };
  }), `enplace-kitchen-${id}`);
}

async function expectConnected(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Share kitchen", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Share kitchen" })).toBeVisible();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close share kitchen" }).click();
  await expect(page.getByRole("dialog", { name: "Share kitchen" })).toHaveCount(0);
}

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
