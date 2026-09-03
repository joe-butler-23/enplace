import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.skip(({ browserName }) => browserName === "webkit", "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");
import { unzipSync } from "fflate";

const SAMPLE_RECIPE_PATHS = readdirSync("sample/recipes").filter((name) => name.endsWith(".md")).sort();
const SAMPLE_IMAGE_PATHS = readdirSync("sample/images").map((name) => `images/${name}`).sort();

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

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

test("a used kitchen remains useful and exportable after both origins disappear", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  const id = new URL(page.url()).hash.slice(3);
  const beforeImport = await persistedUpdateCount(page, id);

  await openSettings(page);
  const input = page.locator(".mep-kitchen-panel__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles([
    {
      name: "Plan.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("## Marked\n- [[banana-oat-loaf]]\n"),
    },
    {
      name: "Shopping.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Shopping\n\n## Other\n- [ ] torch batteries\n- [x] bottled water\n"),
    },
  ]);
  await expect(page.locator(".mep-notices")).toContainText("Imported 2 files; skipped 0 existing files.");
  await expect.poll(() => persistedUpdateCount(page, id)).toBeGreaterThan(beforeImport);
  await page.getByTitle("Close settings").click();
  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "torch batteries" })).toBeVisible();
  await ensureServiceWorkerControl(page);
  const entryScript = await page.locator('script[type="module"]').getAttribute("src");
  expect(entryScript).not.toBeNull();
  await expect.poll(() => page.evaluate(async (url) => Boolean(await caches.match(url)), entryScript!)).toBe(true);

  // Both origins disappear: the browser goes offline, which is exactly what a dead static host
  // and a dead relay look like to the page. Playwright-level request aborts would also starve
  // the service worker's own cache reads, which is not the scenario.
  await context.setOffline(true);

  const response = await page.reload({ waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "torch batteries" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "bottled water" })).toBeChecked();

  await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  await expect(page.locator(".cooking-db__card")).toHaveCount(SAMPLE_RECIPE_PATHS.length);
  await expect(page.getByText("Banana oat loaf", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await page.getByText("torch batteries", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "torch batteries" })).toBeChecked();

  await openSettings(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download kitchen (.zip)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("enplace-kitchen.zip");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const entries = unzipSync(await readFile(downloadPath!));
  expect(Object.keys(entries).sort()).toEqual([
    ...SAMPLE_IMAGE_PATHS,
    "Plan.md",
    ...SAMPLE_RECIPE_PATHS,
    "Shopping.md",
  ].sort());
  expect(new TextDecoder().decode(entries["Shopping.md"])).toContain("- [x] torch batteries");
});
