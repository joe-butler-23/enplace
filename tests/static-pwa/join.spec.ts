import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const OFFLINE_RELOAD_TITLES = new Set(["cached shell offline rejects an unknown kitchen without mounting an editor", "returning device opens its local kitchen offline without a first-sync gate"]);
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
    await expect(partner.getByRole("heading", { name: "Opening your shared kitchen…" })).toBeVisible();
    await expect(partner.getByText("11 recipes", { exact: true })).toBeVisible();
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
});

test("returning device opens its local kitchen offline without a first-sync gate", async ({ page, context }) => {
  const id = await openFreshKitchen(page);
  await cacheControlledShell(page);
  await recordFalseEmpty(page);
  await goOffline(context);

  await page.goto(`/?offline-return=1#k=${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __sawOpeningGate?: boolean }).__sawOpeningGate)).toBe(false);
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
