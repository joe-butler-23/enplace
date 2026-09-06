import { openFreshCookbook } from "./helpers";
import { expect, test, type Page } from "@playwright/test";

// Requests the app shell's service worker proxies cannot be intercepted, so this spec runs without it.
test.use({ serviceWorkers: "block" });

const recipe = (name: string, ingredients: string[], steps: string[]) => ({
  "@context": "https://schema.org", "@type": "Recipe", name, recipeIngredient: ingredients, recipeYield: "2 servings",
  recipeInstructions: steps.map((text) => ({ "@type": "HowToStep", text })),
});
const twoSoups = `<!doctype html><html><head><title>Two chilled soups</title>
<script type="application/ld+json">${JSON.stringify([
  recipe("Cucumber and yoghurt soup", ["1 cucumber", "100g greek yoghurt"], ["Blend everything.", "Chill and serve."]),
  recipe("Watermelon gazpacho", ["250g watermelon flesh", "800g ripe tomatoes"], ["Blitz until smooth."]),
]).replaceAll("<", "\\u003c")}</script></head><body><h1>Two chilled soups</h1></body></html>`;

/** The relay's page route, answered here so the test never leaves the machine. */
async function servePages(page: Page, pages: Record<string, string>): Promise<string[]> {
  const asked: string[] = [];
  await page.route(/\/page\?url=/, async (route) => {
    const target = new URL(route.request().url()).searchParams.get("url") ?? "";
    asked.push(target);
    const html = pages[target];
    if (!html) return route.fulfill({ status: 502, contentType: "text/plain", body: "The page answered with status 404." });
    return route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-final-url": `${target}?final=1`, "access-control-expose-headers": "x-final-url" }, body: html });
  });
  return asked;
}

async function openImport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add recipe", exact: true }).first().click();
  await page.getByRole("button", { name: "Import from a web page", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import from a web page" })).toBeVisible();
}

test("an address alone fetches the page through the relay, lists its recipes and adds the chosen ones", async ({ page }) => {
  await openFreshCookbook(page);
  const asked = await servePages(page, { "https://example.test/two-soups": twoSoups });
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import from a web page" });
  await dialog.getByLabel("Page address").fill("https://example.test/two-soups");
  await dialog.getByRole("button", { name: "Fetch page" }).click();
  const found = dialog.getByRole("list", { name: "Recipes found" }).getByRole("listitem");
  await expect(found).toHaveCount(2);
  expect(asked).toEqual(["https://example.test/two-soups"]);
  await expect(found.nth(0)).toContainText("Cucumber and yoghurt soup");
  await expect(found.nth(0)).toContainText("2 ingredients · 2 steps");
  await expect(dialog.getByRole("button", { name: "Add 2 recipes" })).toBeEnabled();
  await found.nth(1).getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(page.locator(".mep-notices")).toContainText("Added 1 recipe.");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cucumber and yoghurt soup", { exact: true })).toBeVisible();
  await expect(page.getByText("Watermelon gazpacho", { exact: true })).toHaveCount(0);
  await expect(page.getByText("12 recipes", { exact: true })).toBeVisible();
});

test("a page the relay cannot fetch reports the reason, and pasted HTML still works", async ({ page }) => {
  await openFreshCookbook(page);
  await servePages(page, {});
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import from a web page" });
  await dialog.getByLabel("Page address").fill("https://example.test/missing");
  await dialog.getByRole("button", { name: "Fetch page" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The page answered with status 404.");
  await dialog.getByText("Page can't be fetched?").click();
  await dialog.getByLabel("Page HTML").fill(twoSoups);
  await dialog.getByRole("button", { name: "Add 2 recipes" }).click();
  await expect(page.locator(".mep-notices")).toContainText("Added 2 recipes.");
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();

  await openImport(page);
  const again = page.getByRole("dialog", { name: "Import from a web page" });
  await again.getByText("Page can't be fetched?").click();
  await again.getByLabel("Page HTML").fill(twoSoups);
  await again.getByRole("button", { name: "Add 2 recipes" }).click();
  await expect(again.getByRole("alert")).toContainText("already exists");
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();
});
