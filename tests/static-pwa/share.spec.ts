import { expect, test, type Page } from "@playwright/test";

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

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

async function confirmNextDialog(page: Page): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
}

test("share dialog states the access contract and keeps the active route", async ({ page }) => {
  const id = await openFreshKitchen(page);
  await page.getByRole("button", { name: "Shopping List" }).click();
  await expect(page).toHaveURL(new RegExp(`/shopping#k=${id}$`));

  await page.getByRole("button", { name: "Share kitchen" }).click();
  const dialog = page.getByRole("dialog", { name: "Share kitchen" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Anyone with this private link can view and change this kitchen.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Kitchen link")).toHaveValue(`${new URL(page.url()).origin}/shopping#k=${id}`);
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
  await dialog.getByRole("button", { name: "Show QR code" }).click();
  await expect(dialog.getByRole("img", { name: "QR code for this kitchen link" })).toBeVisible();
});



test("sample removal empties the kitchen", async ({ page }) => {
  await openFreshKitchen(page);
  await openSettings(page);
  await confirmNextDialog(page);
  await page.getByRole("button", { name: "Remove sample recipes" }).click();
  await expect(page.locator(".mep-notices")).toContainText("Removed sample recipes.");
  await page.getByTitle("Close settings").click();
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  await expect(page.getByText("0 recipes", { exact: true })).toBeVisible();
});

test("a javascript Markdown link renders inert", async ({ page }) => {
  await openFreshKitchen(page);
  await openSettings(page);
  const input = page.locator(".mep-kitchen-panel__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles({
    name: "unsafe-link.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\ntitle: Unsafe link\n---\n\n## Ingredients\n- 1 test\n\n## Method\n1. [Do not run](javascript:alert('unsafe'))\n"),
  });
  await expect(page.locator(".mep-notices")).toContainText("Imported 1 file; skipped 0 existing files.");
  await page.getByTitle("Close settings").click();
  await page.getByText("Unsafe link", { exact: true }).click();
  const link = page.getByRole("link", { name: "Do not run" });
  await expect(link).toBeVisible();
  expect((await link.getAttribute("href")) ?? "").not.toContain("javascript:");
});
