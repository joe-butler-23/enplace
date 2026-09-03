import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const KITCHEN_ID = /^[a-z2-7]{26}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function newKitchenId(): string {
  return Array.from(randomBytes(26), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

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
  await page.getByRole("button", { name: "Shopping List" }).click();
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
}

async function addShoppingItem(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Add a shopping item").fill(item);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: item })).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

/** Number of Yjs updates y-indexeddb has committed for the kitchen: the durability boundary a reload must not cross early. */
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

test("fresh visit creates and persists a seeded kitchen", async ({ page }) => {
  const id = await openFreshKitchen(page);
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name));
  expect(databases).toContain(`enplace-kitchen-${id}`);
});

test("shopping edits survive reload and the remembered kitchen reopens", async ({ page }) => {
  const id = await openFreshKitchen(page);
  await openShopping(page);
  await addShoppingItem(page, "oat milk");
  const before = await persistedUpdateCount(page, id);
  await page.getByText("oat milk", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "oat milk" })).toBeChecked();
  await expect.poll(() => persistedUpdateCount(page, id)).toBeGreaterThan(before);

  await page.reload();
  await expect(page.getByRole("checkbox", { name: "oat milk" })).toBeChecked();

  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`#k=${id}$`));
  await openShopping(page);
  await expect(page.getByRole("checkbox", { name: "oat milk" })).toBeChecked();
});

test("two separate browser contexts converge through the relay in both directions", async ({ page, browser }) => {
  await openFreshKitchen(page);
  await openShopping(page);
  await addShoppingItem(page, "oat milk");
  await addShoppingItem(page, "eggs");

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  try {
    await second.goto(page.url());
    await expect(second.getByRole("checkbox", { name: "oat milk" })).toBeVisible();
    await expect(second.getByRole("checkbox", { name: "eggs" })).toBeVisible();

    await page.getByText("oat milk", { exact: true }).click();
    await expect.poll(() => second.getByRole("checkbox", { name: "oat milk" }).isChecked()).toBe(true);

    await second.getByText("eggs", { exact: true }).click();
    await expect.poll(() => page.getByRole("checkbox", { name: "eggs" }).isChecked()).toBe(true);
    await expect(page.getByRole("checkbox", { name: "oat milk" })).toBeChecked();
    await expect(second.getByRole("checkbox", { name: "eggs" })).toBeChecked();
  } finally {
    await secondContext.close();
  }
});

test("Settings exposes the connected share contract", async ({ page }) => {
  const id = await openFreshKitchen(page);
  await openSettings(page);
  const origin = new URL(page.url()).origin;
  await expect(page.getByLabel("Kitchen link")).toHaveValue(`${origin}/#k=${id}`);
  await expect(page.getByRole("img", { name: "QR code for this kitchen link" })).toBeVisible();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download kitchen (.zip)" })).toBeVisible();
});

test("Settings imports a synthetic recipe file", async ({ page }) => {
  await openFreshKitchen(page);
  await openSettings(page);
  const input = page.locator(".mep-kitchen-panel__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles({
    name: "browser-soup.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\ntitle: Browser Soup\n---\n\n# Browser Soup\n\n## Ingredients\n- 2 onions\n\n## Method\n1. Simmer.\n"),
  });
  await expect(page.locator(".mep-notices")).toContainText("Imported 1 file; skipped 0 existing files.");
  await page.getByTitle("Close settings").click();
  await expect(page.getByText("12 recipes", { exact: true })).toBeVisible();
  await expect(page.getByText("Browser Soup", { exact: true })).toBeVisible();
});

test("opening another kitchen shows its empty state", async ({ page }) => {
  await openFreshKitchen(page);
  const secondId = newKitchenId();
  await openSettings(page);
  page.once("dialog", (dialog) => dialog.accept(secondId));
  await page.getByRole("button", { name: "Open another kitchen" }).click();

  await expect(page).toHaveURL(new RegExp(`#k=${secondId}$`));
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  await expect(page.getByText("11 recipes", { exact: true })).toHaveCount(0);
});

test("browser back and forward always mount the kitchen the URL names", async ({ page }) => {
  const firstId = await openFreshKitchen(page);
  const secondId = newKitchenId();
  await openSettings(page);
  page.once("dialog", (dialog) => dialog.accept(secondId));
  await page.getByRole("button", { name: "Open another kitchen" }).click();
  await expect(page).toHaveURL(new RegExp(`#k=${secondId}$`));
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#k=${firstId}$`));
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("enplace-current-kitchen"))).toBe(firstId);

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#k=${secondId}$`));
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("enplace-current-kitchen"))).toBe(secondId);
});

test("the kitchen app shell reloads offline after its first visit", async ({ page, context }) => {
  await openFreshKitchen(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await openShopping(page);
  await expect(page).toHaveURL(/\/shopping#k=[a-z2-7]{26}$/);

  await context.setOffline(true);
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("Enplace");
  await expect(page.locator("#root")).toHaveCount(1);
});
