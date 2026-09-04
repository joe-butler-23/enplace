import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const OFFLINE_RELOAD_TITLES = new Set([
  "cached shell offline rejects an unknown kitchen without mounting an editor",
  "a persisted kitchen emptied before close reopens offline without a first-sync gate",
  "a linked device persists successful first sync for offline reopen",
]);
test.beforeEach(async ({ browserName }, testInfo) => {
  if (browserName === "webkit" && OFFLINE_RELOAD_TITLES.has(testInfo.title)) testInfo.skip(true, "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");
});

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const NOT_DOWNLOADED = "This device hasn't downloaded this kitchen yet. Connect to the internet once to open it.";

function newKitchenId(): string {
  return Array.from(randomBytes(26), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

function kitchenId(page: Page): string {
  const id = new URL(page.url()).hash.match(/^#k=([a-z2-7]{26})$/)?.[1];
  if (!id) throw new Error(`Page has no kitchen id: ${page.url()}`);
  return id;
}

async function openFreshKitchen(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  return kitchenId(page);
}

async function addShoppingItem(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Add a shopping item").fill(item);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: item })).toBeVisible();
}

async function cacheControlledShell(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

async function precreateIncompatibleKitchenDatabase(page: Page, id: string): Promise<void> {
  await page.evaluate(async (name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("updates", { autoIncrement: true });
      request.result.createObjectStore("custom", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Kitchen database creation was blocked."));
    request.onsuccess = () => { request.result.close(); resolve(); };
  }), `enplace-kitchen-${id}`);
}

async function kitchenPersistenceCounts(page: Page, id: string): Promise<{ updates: number; markers: number }> {
  return page.evaluate(async (name) => new Promise<{ updates: number; markers: number }>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["updates", "custom"], "readonly");
      const updates = transaction.objectStore("updates").count();
      const markers = transaction.objectStore("custom").count();
      transaction.oncomplete = () => { db.close(); resolve({ updates: updates.result, markers: markers.result }); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), `enplace-kitchen-${id}`);
}

async function recordFalseEmpty(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __sawFalseEmpty?: boolean; __sawOpeningGate?: boolean };
    state.__sawFalseEmpty = false;
    state.__sawOpeningGate = false;
    const inspect = (): void => {
      const text = document.body?.innerText ?? "";
      if (text.includes("No recipes yet")) state.__sawFalseEmpty = true;
      if (text.includes("Opening your shared kitchen")) state.__sawOpeningGate = true;
    };
    new MutationObserver(inspect).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener("DOMContentLoaded", inspect, { once: true });
  });
}

async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}

test("partner join waits for first sync without showing a false empty kitchen", async ({ page, browser, browserName }) => {
  test.skip(browserName !== "chromium", "CDP network emulation is a Chromium-only proof");
  const id = await openFreshKitchen(page);
  await addShoppingItem(page, "sync proof");
  await page.getByRole("button", { name: "Share kitchen" }).click();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();

  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  try {
    await recordFalseEmpty(partner);
    const cdp = await partnerContext.newCDPSession(partner);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 1_500,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "wifi",
    });
    await partner.goto(`/#k=${id}`, { waitUntil: "domcontentloaded" });
    await expect(partner.getByText("11 recipes", { exact: true })).toBeVisible();
    expect(await partner.evaluate(() => (window as typeof window & { __sawOpeningGate?: boolean }).__sawOpeningGate)).toBe(true);
    expect(await partner.evaluate(() => (window as typeof window & { __sawFalseEmpty?: boolean }).__sawFalseEmpty)).toBe(false);
  } finally {
    await partnerContext.close();
  }
});

test("cached shell offline rejects an unknown kitchen without mounting an editor", async ({ page, context }) => {
  await openFreshKitchen(page);
  await cacheControlledShell(page);
  await goOffline(context);

  await page.goto(`/settings#k=${newKitchenId()}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(NOT_DOWNLOADED, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toHaveCount(0);
  await expect(page.locator(".mep-shell, textarea, [contenteditable=true]")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(NOT_DOWNLOADED, { exact: true })).toBeVisible();
  await expect(page.locator(".mep-shell, textarea, [contenteditable=true]")).toHaveCount(0);
});

test("a persisted kitchen emptied before close reopens offline without a first-sync gate", async ({ page, context }) => {
  const id = await openFreshKitchen(page);
  await cacheControlledShell(page);
  const beforeRemoval = (await kitchenPersistenceCounts(page, id)).updates;
  await goOffline(context);
  await page.getByRole("button", { name: "Settings" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove sample recipes" }).click();
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  await expect.poll(async () => (await kitchenPersistenceCounts(page, id)).updates).toBeGreaterThan(beforeRemoval);

  const url = page.url();
  await page.close();
  page = await context.newPage();
  await recordFalseEmpty(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __sawOpeningGate?: boolean }).__sawOpeningGate)).toBe(false);
});

test("a linked device persists successful first sync for offline reopen", async ({ page, browser }) => {
  const id = await openFreshKitchen(page);
  await addShoppingItem(page, "linked sync proof");

  const linkedContext = await browser.newContext();
  let linked = await linkedContext.newPage();
  try {
    await linked.goto(`/shopping#k=${id}`);
    await expect(linked.getByRole("checkbox", { name: "linked sync proof" })).toBeVisible();
    await cacheControlledShell(linked);
    const url = linked.url();
    await linked.close();
    await linkedContext.setOffline(true);
    linked = await linkedContext.newPage();
    await recordFalseEmpty(linked);
    await linked.goto(url, { waitUntil: "domcontentloaded" });
    await expect(linked.getByRole("checkbox", { name: "linked sync proof" })).toBeVisible();
    expect(await linked.evaluate(() => (window as typeof window & { __sawOpeningGate?: boolean }).__sawOpeningGate)).toBe(false);
  } finally {
    await linkedContext.close();
  }
});

test("first-sync marker transaction failure fails closed without browser errors", async ({ page }) => {
  await page.goto("/");
  const id = newKitchenId();
  await precreateIncompatibleKitchenDatabase(page, id);
  await page.addInitScript(() => {
    const state = window as typeof window & { __unhandledRejections?: string[] };
    state.__unhandledRejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      state.__unhandledRejections!.push(String(event.reason));
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`/#k=${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Enplace could not open your kitchen" })).toBeVisible();
  await expect(page.locator(".mep-shell, textarea, [contenteditable=true]")).toHaveCount(0);
  await expect(kitchenPersistenceCounts(page, id)).resolves.toEqual({ updates: 1, markers: 0 });
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => (window as typeof window & { __unhandledRejections?: string[] }).__unhandledRejections)).toEqual([]);
});

test("fresh sample kitchen reaches the relay only after its first edit", async ({ page, browser }) => {
  const id = await openFreshKitchen(page);
  await page.reload();
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  try {
    await partner.goto(`/#k=${id}`);
    await expect(partner.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
    await expect(partner.getByText("11 recipes", { exact: true })).toHaveCount(0);

    await addShoppingItem(page, "publish kitchen");
    await expect(partner.getByText("11 recipes", { exact: true })).toBeVisible();
    await partner.getByRole("button", { name: "Shopping List", exact: true }).click();
    await expect(partner.getByRole("checkbox", { name: "publish kitchen" })).toBeVisible();
  } finally {
    await partnerContext.close();
  }
});
