import { expect, test, type Page } from "@playwright/test";
import { openFreshCookbook } from "./helpers";

async function sidebarHeight(page: Page): Promise<number> {
  return page.locator(".mep-sidebar").evaluate((element) => element.getBoundingClientRect().height);
}

test("phone shell keeps every route on the same navigation row and database controls in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFreshCookbook(page);

  await page.getByLabel("Search recipes").fill("banana");
  const databaseHeight = await sidebarHeight(page);
  for (const selector of [".cooking-db__sort", ".cooking-db__filter"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }

  await page.getByRole("button", { name: "Planner", exact: true }).click();
  await expect(page.locator(".kanban-container")).toBeVisible();
  const plannerHeight = await sidebarHeight(page);

  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
  const shoppingHeight = await sidebarHeight(page);

  expect(Math.abs(databaseHeight - shoppingHeight)).toBeLessThanOrEqual(3);
  expect(Math.abs(plannerHeight - shoppingHeight)).toBeLessThanOrEqual(3);
});
