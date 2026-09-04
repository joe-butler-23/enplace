import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { openFreshKitchen, openShopping, persistedUpdateCount } from "./helpers";

async function openPlanner(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Planner" }).click();
  await expect(page.locator(".organiser-column-note").first()).toBeVisible();
}

async function addShoppingItem(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Add an item" }).click();
  await page.getByLabel("Add a shopping item").fill(item);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: item }).last()).toBeVisible();
}

test("a planner day note syncs to another device and exports in Plan.md", async ({ page, browser }) => {
  await openFreshKitchen(page);
  await openPlanner(page);
  const note = "Grandma visiting, cook early";
  const noteButton = page.locator(".organiser-column-note").first();
  const date = await noteButton.getAttribute("data-date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("Enter note for this day:");
    await dialog.accept(note);
  });
  await noteButton.click();
  await expect(page.locator(`.organiser-column-note[data-date="${date}"]`)).toHaveText(note);

  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  try {
    await second.goto(page.url());
    await expect(second.locator(`.organiser-column-note[data-date="${date}"]`)).toHaveText(note);
  } finally {
    await secondContext.close();
  }

  await page.getByRole("button", { name: "Settings" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download kitchen (.zip)" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const archive = unzipSync(new Uint8Array(await readFile(downloadPath!)));
  expect(strFromU8(archive["Plan.md"])).toContain(`## ${date}\n> ${note}\n`);
});

test("shopping reports offline work and one caught-up state", async ({ page, context }) => {
  await openFreshKitchen(page);
  await openShopping(page);
  await addShoppingItem(page, "relay test item");
  await expect(page.getByText("Offline. Your ticks are saved on this phone.", { exact: true })).toHaveCount(0);

  await context.setOffline(true);
  await expect(page.getByText("Offline. Your ticks are saved on this phone.", { exact: true })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText("Offline. Your ticks are saved on this phone.", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Recipe Database" }).click();
  await openShopping(page);
});

test("duplicate shopping items keep independent line identity", async ({ page }) => {
  await openFreshKitchen(page);
  await openShopping(page);
  await addShoppingItem(page, "milk");
  await addShoppingItem(page, "milk");
  const milk = page.getByRole("checkbox", { name: "milk" });
  await expect(milk).toHaveCount(2);

  await page.getByText("milk", { exact: true }).nth(1).click();
  await expect(milk.nth(0)).not.toBeChecked();
  await expect(milk.nth(1)).toBeChecked();

  await page.getByText("milk", { exact: true }).nth(0).click();
  await expect(milk.nth(0)).toBeChecked();
  await expect(milk.nth(1)).toBeChecked();
});

test("planner keyboard movement persists the card in the adjacent date lane", async ({ page }) => {
  const id = await openFreshKitchen(page);
  const title = "Banana oat loaf";
  const marked = page.locator(".cooking-db__card", { hasText: title }).getByRole("checkbox", { name: "Marked" });
  await marked.check();
  await expect(marked).toBeChecked();
  await expect(marked).toBeEnabled();

  await openPlanner(page);
  const sourceLane = page.locator('.kanban-board[data-id="marked"]');
  const targetLane = page.locator(".kanban-board").nth(1);
  const targetDate = await targetLane.getAttribute("data-id");
  expect(targetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const card = sourceLane.getByRole("button", { name: `Open ${title}` });
  await card.focus();
  const beforeMove = await persistedUpdateCount(page, id);
  await card.press("ArrowRight");
  await expect(targetLane.getByRole("button", { name: `Open ${title}` })).toBeVisible();
  await expect.poll(() => persistedUpdateCount(page, id)).toBeGreaterThan(beforeMove);

  await page.reload();
  await expect(page.locator(`.kanban-board[data-id="${targetDate}"]`).getByRole("button", { name: `Open ${title}` })).toBeVisible();
});
