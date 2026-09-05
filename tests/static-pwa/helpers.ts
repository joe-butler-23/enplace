import { newCookbookId } from "../../src/cookbook/doc";
import { openCookbook, type CookbookConnection } from "../../src/host-client/cookbook-storage";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

export async function openFreshCookbook(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page).toHaveURL(/#k=e1_[a-z2-7]{52}$/);
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  return new URL(page.url()).hash.slice(3);
}

export async function openShopping(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
}

export async function addShoppingItem(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Add a shopping item").fill(item);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: item })).toBeVisible();
}

/** Number of Yjs updates y-indexeddb has committed for the cookbook: the durability boundary a reload must not cross early. */
export async function persistedUpdateCount(page: Page, id: string): Promise<number> {
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

export async function exportedCookbookText(page: Page, path: string): Promise<string> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download cookbook (.zip)" }).click();
  const download = await downloading;
  const archive = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  const bytes = archive[path];
  expect(bytes, `${path} should be present in the cookbook export`).toBeDefined();
  await page.getByTitle("Close settings").click();
  return strFromU8(bytes);
}

/** Keep this owner connected until the test ends: the test relay keeps rooms in memory. */
export async function createEmptyCookbookConnection(): Promise<CookbookConnection> {
  const connection = await openCookbook({ id: newCookbookId(), persist: false, seed: () => {},
    relayUrl: `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}` });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { stop(); reject(new Error("Empty cookbook fixture did not publish")); }, 5000);
      const stop = connection.onRemoteSync(() => { clearTimeout(deadline); stop(); resolve(); });
      if (connection.remoteSynced()) { clearTimeout(deadline); stop(); resolve(); }
    });
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}
