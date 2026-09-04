import { randomBytes } from "node:crypto";
import { cpSync, rmSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { addShoppingItem, openFreshCookbook, openShopping, persistedUpdateCount } from "./helpers";

const OFFLINE_RELOAD_TITLES = new Set(["the cookbook app shell reloads offline after its first visit"]);
test.beforeEach(async ({ browserName }, testInfo) => {
  if (browserName === "webkit" && OFFLINE_RELOAD_TITLES.has(testInfo.title)) testInfo.skip(true, "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");
});

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function newCookbookId(): string {
  return Array.from(randomBytes(26), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

function serveBuild(build: "a" | "b"): void {
  rmSync("dist-static", { recursive: true });
  cpSync(`tmp/static-pwa-${build}`, "dist-static", { recursive: true });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

test("the covers pack loads once after seeding and never on a return visit", async ({ page }) => {
  const packs: string[] = [];
  page.on("request", (request) => {
    const file = new URL(request.url()).pathname.split("/").pop() ?? "";
    if (!file.endsWith(".pack")) return;
    // Built names carry a content hash; record the pack each one is a build of.
    packs.push(file.startsWith("sample-covers-") ? "sample-covers.pack" : "sample-pack.pack");
  });

  await openFreshCookbook(page);
  // The grid paints from the seed pack; the covers follow it without holding anything up.
  expect(packs[0]).toBe("sample-pack.pack");
  await expect.poll(() => packs).toEqual(["sample-pack.pack", "sample-covers.pack"]);
  await expect(page.locator(".cooking-db__cover img").first()).toBeVisible();

  packs.length = 0;
  await page.reload();
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  await expect(page.locator(".cooking-db__cover img").first()).toBeVisible();
  expect(packs).toEqual([]);
});

test("fresh visit creates and persists a seeded cookbook", async ({ page }) => {
  const id = await openFreshCookbook(page);
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name));
  expect(databases).toContain(`enplace-kitchen-${id}`);
});

test("a waiting build activates once and keeps the persisted cookbook", async ({ page }) => {
  serveBuild("a");
  const id = await openFreshCookbook(page);
  await page.evaluate(async () => {
    const controlled = new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await controlled;
  });
  await openShopping(page);
  await addShoppingItem(page, "update basil");
  const before = await persistedUpdateCount(page, id);
  await page.getByText("update basil", { exact: true }).click();
  expect(await persistedUpdateCount(page, id)).toBeGreaterThan(before);

  const keeper = await page.context().newPage();
  await keeper.goto(page.url());
  await expect(keeper.getByRole("heading", { name: "Shopping list" })).toBeVisible();
  expect(await keeper.evaluate(() => navigator.serviceWorker.controller?.state)).toBe("activated");
  try {
    serveBuild("b");
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      const worker = registration.waiting ?? registration.installing;
      if (!worker) throw new Error("Build B did not install");
      if (worker.state !== "installed") {
        await new Promise<void>((resolve, reject) => {
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed") resolve();
            if (worker.state === "redundant") reject(new Error("Build B became redundant"));
          });
        });
      }
    });

    const status = page.getByRole("status");
    const action = status.getByRole("button", { name: "Reload to update", exact: true });
    await expect(status.getByText("An Enplace update is ready.", { exact: true })).toBeVisible();
    await expect(action).toBeEnabled();
    await page.reload();
    await expect(status.getByText("An Enplace update is ready.", { exact: true })).toBeVisible();
    await expect(action).toBeEnabled();

    await action.evaluate((button) => {
      sessionStorage.setItem("mep-test-update-clicks", "0");
      button.addEventListener("click", () => {
        const clicks = Number(sessionStorage.getItem("mep-test-update-clicks"));
        sessionStorage.setItem("mep-test-update-clicks", String(clicks + 1));
      });
    });
    await page.evaluate(() => sessionStorage.setItem("mep-test-document-loads", "0"));
    await page.addInitScript(() => {
      const loads = Number(sessionStorage.getItem("mep-test-document-loads"));
      sessionStorage.setItem("mep-test-document-loads", String(loads + 1));
    });
    const navigationUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigationUrls.push(frame.url());
    });
    await Promise.all([page.waitForEvent("load"), action.dblclick()]);

    await expect(page.getByRole("checkbox", { name: "update basil" })).toBeChecked();
    const documentLoads = await page.evaluate(() => sessionStorage.getItem("mep-test-document-loads"));
    expect(documentLoads, `Navigation events: ${JSON.stringify(navigationUrls)}`).toBe("1");
    expect(await page.evaluate(() => sessionStorage.getItem("mep-test-update-clicks"))).toBe("1");
    expect(navigationUrls.length).toBeGreaterThan(0);
    expect(navigationUrls.every((url) => url === page.url())).toBe(true);
    expect(await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return [registration.waiting, Boolean(registration.active), navigator.serviceWorker.controller === registration.active];
    })).toEqual([null, true, true]);
    await expect(page).toHaveURL(new RegExp(`/shopping#k=${id}$`));
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`#k=${id}$`));
    await openShopping(page);
    await expect(page.getByRole("checkbox", { name: "update basil" })).toBeChecked();
  } finally {
    await keeper.close();
  }
});

test("two separate browser contexts converge through the relay in both directions", async ({ page, browser }) => {
  await openFreshCookbook(page);
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

test("an untouched cookbook reads local-only in Settings and is exportable from there", async ({ page }) => {
  await openFreshCookbook(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByText("This cookbook lives only on this device.", { exact: false })).toBeVisible();
  await expect(settings.getByText("Anyone with this private link can view and change this cookbook.", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Download cookbook (.zip)" })).toBeVisible();
});

test("Settings imports a synthetic recipe file", async ({ page }) => {
  await openFreshCookbook(page);
  await openSettings(page);
  const input = page.locator(".mep-settings__file-button", { hasText: "Import files" }).locator('input[type="file"]');
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

test("opening another cookbook shows its empty state", async ({ page }) => {
  await openFreshCookbook(page);
  const secondId = newCookbookId();
  await openSettings(page);
  page.once("dialog", (dialog) => dialog.accept(secondId));
  await page.getByRole("button", { name: "Paste a link" }).click();

  await expect(page).toHaveURL(new RegExp(`#k=${secondId}$`));
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  await expect(page.getByText("11 recipes", { exact: true })).toHaveCount(0);
});

test("browser back and forward always mount the cookbook the URL names", async ({ page }) => {
  const firstId = await openFreshCookbook(page);
  const secondId = newCookbookId();
  await openSettings(page);
  page.once("dialog", (dialog) => dialog.accept(secondId));
  await page.getByRole("button", { name: "Paste a link" }).click();
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

test("the cookbook app shell reloads offline after its first visit", async ({ page, context }) => {
  await openFreshCookbook(page);
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
