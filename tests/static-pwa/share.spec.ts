import { expect, test, type Page } from "@playwright/test";
import { openFreshCookbook } from "./helpers";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

async function confirmNextDialog(page: Page): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
}

test("share dialog states the access contract and keeps the active route", async ({ page }) => {
  const id = await openFreshCookbook(page);
  await page.getByRole("button", { name: "Shopping List" }).click();
  await expect(page).toHaveURL(new RegExp(`/shopping#k=${id}$`));

  await page.getByRole("button", { name: "Share cookbook" }).click();
  const dialog = page.getByRole("dialog", { name: "Share cookbook" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Anyone with this private link can view and change this cookbook.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Cookbook link")).toHaveValue(`${new URL(page.url()).origin}/shopping#k=${id}`);
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
  await dialog.getByRole("button", { name: "Show QR code" }).click();
  await expect(dialog.getByRole("img", { name: "QR code for this cookbook link" })).toBeVisible();
});



test("sample removal empties the cookbook", async ({ page }) => {
  await openFreshCookbook(page);
  await openSettings(page);
  await confirmNextDialog(page);
  await page.getByRole("button", { name: "Remove sample recipes" }).click();
  await expect(page.locator(".mep-notices")).toContainText("Removed sample recipes.");
  await page.getByTitle("Close settings").click();
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
  await expect(page.getByText("0 recipes", { exact: true })).toBeVisible();
});

test("a javascript Markdown link renders inert", async ({ page }) => {
  await openFreshCookbook(page);
  await openSettings(page);
  const input = page.locator(".mep-cookbook-panel__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles({
    name: "unsafe-link.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("---\ntitle: Unsafe link\n---\n\n## Ingredients\n- 1 test\n\n## Method\n1. [Do not run](javascript:alert('unsafe'))\n"),
  });
  await expect(page.locator(".mep-notices")).toContainText("Imported 1 file; skipped 0 existing files.");
  await page.getByTitle("Close settings").click();
  await page.getByText("Unsafe link", { exact: true }).click();
  await expect(page.getByText("Do not run", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Do not run" })).toHaveCount(0);
});
