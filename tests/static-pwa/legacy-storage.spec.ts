import { expect, test, type Page } from "@playwright/test";

const PRE_RENAME_COOKBOOK_ID = "prerenamecookbookproofabcd";
// Encoded by the e22f8d8 document schema before the cookbook rename.
const PRE_RENAME_UPDATE = "AQL36ZrpDQAoAQVmaWxlcxNwcmUtcmVuYW1lLXByb29mLm1kAXcEdGV4dAQBGHRleHQ6cHJlLXJlbmFtZS1wcm9vZi5tZLQBLS0tCnRpdGxlOiBQcmUtcmVuYW1lIHByb29mIHNvdXAKdGFnczogW2ZpeHR1cmVdCi0tLQpBIHJlY2lwZSBwZXJzaXN0ZWQgYmVmb3JlIHRoZSBjb29rYm9vayByZW5hbWUuCgojIyBJbmdyZWRpZW50cwotIG9uZSBjb21wYXRpYmlsaXR5IGNoZWNrCgojIyBNZXRob2QKMS4gT3BlbiB0aGUgZXhpc3RpbmcgZGF0YS4KAA==";

async function installPreRenameFixture(page: Page): Promise<void> {
  await page.goto("/manifest.webmanifest");
  await page.evaluate(async ({ id, encodedUpdate }) => new Promise<void>((resolve, reject) => {
    // Historical kitchen database prefix is the compatibility surface under test.
    const request = indexedDB.open(`enplace-kitchen-${id}`, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("updates", { autoIncrement: true });
      request.result.createObjectStore("custom");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Pre-rename database creation was blocked."));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(["updates", "custom"], "readwrite");
      transaction.objectStore("updates").add(Uint8Array.from(atob(encodedUpdate), (value) => value.charCodeAt(0)));
      transaction.objectStore("custom").put(1, "has-local-copy");
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), { id: PRE_RENAME_COOKBOOK_ID, encodedUpdate: PRE_RENAME_UPDATE });
}

test("a pre-rename IndexedDB cookbook still opens", async ({ page }) => {
  await installPreRenameFixture(page);
  await page.goto(`/#k=${PRE_RENAME_COOKBOOK_ID}`);

  await expect(page.getByRole("button", { name: "Open recipe Pre-rename proof soup" })).toBeVisible();
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name));
  expect(databases).toContain(`enplace-kitchen-${PRE_RENAME_COOKBOOK_ID}`);
  expect(databases).not.toContain(`enplace-cookbook-${PRE_RENAME_COOKBOOK_ID}`);
});
