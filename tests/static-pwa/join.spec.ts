import { randomBytes } from "node:crypto";
import { expect, test, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

const OFFLINE_RELOAD_TITLES = new Set([
  "cached shell offline rejects an unknown cookbook without mounting an editor",
  "a persisted cookbook emptied before close reopens offline without a first-sync gate",
  "a linked device persists successful first sync for offline reopen",
  "a first sync of an empty cookbook reopens offline",
]);
test.beforeEach(async ({ browserName }, testInfo) => {
  if (browserName === "webkit" && OFFLINE_RELOAD_TITLES.has(testInfo.title)) testInfo.skip(true, "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");
});

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const NOT_DOWNLOADED = /This device hasn't downloaded this cookbook yet/;

function newCookbookId(): string {
  return Array.from(randomBytes(26), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

function cookbookId(page: Page): string {
  const id = new URL(page.url()).hash.match(/^#k=([a-z2-7]{26})$/)?.[1];
  if (!id) throw new Error(`Page has no cookbook id: ${page.url()}`);
  return id;
}

async function openFreshCookbook(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  return cookbookId(page);
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

async function precreateIncompatibleCookbookDatabase(page: Page, id: string): Promise<void> {
  await page.evaluate(async (name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("updates", { autoIncrement: true });
      request.result.createObjectStore("custom", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Cookbook database creation was blocked."));
    request.onsuccess = () => { request.result.close(); resolve(); };
  }), `enplace-kitchen-${id}`);
}

async function cookbookPersistenceCounts(page: Page, id: string): Promise<{ updates: number; markers: number }> {
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
    const state = window as typeof window & { __sawFalseEmpty?: boolean; };
    state.__sawFalseEmpty = false;
    const inspect = (): void => {
      const text = document.body?.innerText ?? "";
      if (text.includes("No recipes yet")) state.__sawFalseEmpty = true;
    };
    new MutationObserver(inspect).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener("DOMContentLoaded", inspect, { once: true });
  });
}

async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}

test("partner join waits for first sync without showing a false empty cookbook", async ({ page, browser, browserName }) => {
  test.skip(browserName !== "chromium", "CDP network emulation is a Chromium-only proof");
  const id = await openFreshCookbook(page);
  await addShoppingItem(page, "sync proof");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
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
    expect(await partner.evaluate(() => (window as typeof window & { __sawFalseEmpty?: boolean }).__sawFalseEmpty)).toBe(false);
  } finally {
    await partnerContext.close();
  }
});

test("cached shell offline rejects an unknown cookbook without mounting an editor", async ({ page, context }) => {
  await openFreshCookbook(page);
  await cacheControlledShell(page);
  await goOffline(context);

  await page.goto(`/settings#k=${newCookbookId()}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(NOT_DOWNLOADED)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toHaveCount(0);
  await expect(page.locator(".mep-shell, textarea, [contenteditable=true]")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(NOT_DOWNLOADED)).toBeVisible();
  await expect(page.locator(".mep-shell, textarea, [contenteditable=true]")).toHaveCount(0);
});

test("a persisted cookbook emptied before close reopens offline without a first-sync gate", async ({ page, context }) => {
  const id = await openFreshCookbook(page);
  await cacheControlledShell(page);
  const beforeRemoval = (await cookbookPersistenceCounts(page, id)).updates;
  await goOffline(context);
  await page.getByRole("button", { name: "Settings" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove sample recipes" }).click();
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  await expect.poll(async () => (await cookbookPersistenceCounts(page, id)).updates).toBeGreaterThan(beforeRemoval);

  const url = page.url();
  await page.close();
  page = await context.newPage();
  await recordFalseEmpty(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
});

test("a linked device persists successful first sync for offline reopen", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
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
  } finally {
    await linkedContext.close();
  }
});

test("first-sync marker transaction failure fails closed without browser errors", async ({ page }) => {
  await page.goto("/");
  const id = newCookbookId();
  await precreateIncompatibleCookbookDatabase(page, id);
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
  await expect(page.getByRole("heading", { name: "Enplace could not open your cookbook" })).toBeVisible();
  await expect(page.locator(".mep-shell, textarea, [contenteditable=true]")).toHaveCount(0);
  await expect(cookbookPersistenceCounts(page, id)).resolves.toEqual({ updates: 1, markers: 0 });
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => (window as typeof window & { __unhandledRejections?: string[] }).__unhandledRejections)).toEqual([]);
});

test("fresh sample cookbook publishes when its link section is shown", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
  await page.reload();
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  const partnerContext = await browser.newContext();
  const partner = await partnerContext.newPage();
  try {
    await partner.goto(`/#k=${id}`);
    await expect(partner.getByRole("heading", { name: "No recipes yet" })).toBeVisible();

    await page.context().setOffline(true);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    // Connecting reads as preparation; a socket that has already failed reads as offline. Either is honest here.
    await expect(page.getByText(/^(Preparing the shared copy…|Offline\. Changes will sync when the relay reconnects\.)$/)).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
    await expect(partner.getByText("11 recipes", { exact: true })).toBeVisible();
  } finally {
    await partnerContext.close();
  }
});


// Buffer the client's initial handshake while delaying the transport; dropping it would
// create a different protocol failure rather than a late successful connection.
function delaySocket(socket: WebSocketRoute): () => void {
  const messages: Array<string | Buffer> = [];
  socket.onMessage((message) => messages.push(message));
  return () => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
    for (const message of messages) server.send(message);
  };
}

test("a join recovers after its deadline without reload and mounts only once", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
  await addShoppingItem(page, "deadline recovery");
  const context = await browser.newContext();
  const partner = await context.newPage();
  let release!: () => void;
  let reconnect = (): void => {};
  let available = false;
  let connections = 0;
  await context.routeWebSocket(/.*/, (socket) => {
    connections += 1;
    if (available) socket.connectToServer();
    else {
      release = () => { available = true; delay(); };
      const delay = delaySocket(socket);
      reconnect = () => socket.close();
    }
  });
  try {
    await recordFalseEmpty(partner);
    await partner.goto(`/shopping#k=${id}`);
    await expect(partner.getByText(NOT_DOWNLOADED)).toBeVisible();
    const navigations: string[] = [];
    partner.on("framenavigated", (frame) => { if (frame === partner.mainFrame()) navigations.push(frame.url()); });
    release();
    await expect(partner.getByRole("checkbox", { name: "deadline recovery" })).toBeVisible();
    expect(navigations).toEqual([]);
    expect(await partner.evaluate(() => (window as typeof window & { __sawFalseEmpty?: boolean }).__sawFalseEmpty)).toBe(false);
    await partner.evaluate(() => {
      const state = window as typeof window & { __originalShell?: Element | null };
      state.__originalShell = document.querySelector('.mep-shell');
    });
    reconnect();
    await expect.poll(() => connections).toBeGreaterThan(1);
    // A new handshake and remote update must leave the mounted shell intact.
    await addShoppingItem(page, "second sync proof");
    await expect(partner.getByRole("checkbox", { name: "second sync proof" })).toBeVisible();
    expect(await partner.evaluate(() => (window as typeof window & { __originalShell?: Element }).__originalShell === document.querySelector('.mep-shell'))).toBe(true);
  } finally { await context.close(); }
});

test("a disconnected first join recovers through the provider reconnect", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
  await addShoppingItem(page, "reconnect recovery");
  const context = await browser.newContext();
  const partner = await context.newPage();
  let available = false;
  await context.routeWebSocket(/.*/, (socket) => {
    if (available) socket.connectToServer(); else socket.close();
  });
  try {
    await partner.goto(`/shopping#k=${id}`);
    await expect(partner.getByText(NOT_DOWNLOADED)).toBeVisible();
    available = true;
    await expect(partner.getByRole("checkbox", { name: "reconnect recovery" })).toBeVisible();
  } finally { await context.close(); }
});

test("a cancelled opening cannot mount when the delayed relay responds", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
  await addShoppingItem(page, "cancelled recovery");
  const context = await browser.newContext();
  const partner = await context.newPage();
  let release!: () => void;
  await context.routeWebSocket(/.*/, (socket) => { release = delaySocket(socket); });
  try {
    await partner.goto(`/shopping#k=${id}`);
    await expect(partner.getByText(NOT_DOWNLOADED)).toBeVisible();
    await partner.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    release();
    await expect(partner.locator('.mep-shell')).toHaveCount(0);
    await expect(partner.getByText(NOT_DOWNLOADED)).toBeVisible();
  } finally { await context.close(); }
});

test("database-open failure is a storage error without an unhandled rejection", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string, version?: number) => {
      if (!name.startsWith('enplace-kitchen-')) return open(name, version);
      const request = { error: new DOMException('Storage denied', 'UnknownError'), onerror: null as null | (() => void) };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    }) as typeof indexedDB.open;
  });
  await page.goto(`/#k=${newCookbookId()}`);
  await expect(page.getByRole('heading', { name: 'Enplace could not open your cookbook' })).toBeVisible();
  await expect(page.getByText('Storage denied', { exact: true })).toBeVisible();
  await expect(page.locator('.mep-shell')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an asynchronous first-copy abort after the warning reports storage failure", async ({ page }) => {
  const id = newCookbookId();
  let release!: () => void;
  await page.routeWebSocket(/.*/, (socket) => { release = delaySocket(socket); });
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args);
      if (this.name.startsWith('enplace-kitchen-') && tx.objectStoreNames.contains('updates') && tx.objectStoreNames.contains('custom')) {
        const store = tx.objectStore('custom');
        const put = store.put.bind(store);
        store.put = (...putArgs: Parameters<typeof put>) => {
          const request = put(...putArgs);
          request.addEventListener('success', () => tx.abort());
          return request;
        };
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name: string) => name === 'custom' ? store : objectStore(name);
      }
      return tx;
    };
  });
  await page.goto(`/#k=${id}`);
  await expect(page.getByText(NOT_DOWNLOADED)).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'Enplace could not open your cookbook' })).toBeVisible();
  await expect(page.locator('.mep-shell')).toHaveCount(0);
  expect((await cookbookPersistenceCounts(page, id)).markers).toBe(0);
});


test("a first sync of an empty cookbook reopens offline", async ({ page, context }) => {
  const id = newCookbookId();
  await page.goto(`/#k=${id}`);
  await expect(page.getByRole('heading', { name: 'No recipes yet' })).toBeVisible();
  expect((await cookbookPersistenceCounts(page, id)).markers).toBe(1);
  await cacheControlledShell(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No recipes yet' })).toBeVisible();
  await expect(page.getByText(NOT_DOWNLOADED)).toHaveCount(0);
});
