import { exportedCookbookText, openFreshCookbook } from "./helpers";
import { expect, test, type Page } from "@playwright/test";

// Requests the app shell's service worker proxies cannot be intercepted, so this spec runs without it.
test.use({ serviceWorkers: "block" });

const recipe = (name: string, ingredients: string[], steps: string[], image?: string) => ({
  "@context": "https://schema.org", "@type": "Recipe", name, recipeIngredient: ingredients, recipeYield: "2 servings",
  recipeInstructions: steps.map((text) => ({ "@type": "HowToStep", text })), ...(image ? { image } : {}),
});
// A 1×1 PNG: the picture the relay returns for the first recipe.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const twoSoups = `<!doctype html><html><head><title>Two chilled soups</title>
<script type="application/ld+json">${JSON.stringify([
  recipe("Cucumber and yoghurt soup", ["1 cucumber", "100g greek yoghurt"], ["Blend everything.", "Chill and serve."], "https://example.test/cucumber.png"),
  recipe("Watermelon gazpacho", ["250g watermelon flesh", "800g ripe tomatoes"], ["Blitz until smooth."]),
]).replaceAll("<", "\\u003c")}</script></head><body><h1>Two chilled soups</h1></body></html>`;

/** The relay's page and picture routes, answered here so the test never leaves the machine. */
async function servePages(page: Page, pages: Record<string, string>): Promise<string[]> {
  const asked: string[] = [];
  await page.route(/\/image\?url=/, async (route) => {
    const target = new URL(route.request().url()).searchParams.get("url") ?? "";
    asked.push(`image:${target}`);
    return target.endsWith(".png") ? route.fulfill({ status: 200, contentType: "image/png", body: PNG }) : route.fulfill({ status: 415, contentType: "text/plain", body: "That address is not a picture." });
  });
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
  // The picture is fetched through the relay and stored as the cover; an engine that cannot encode WebP keeps the recipe without one.
  const pictured = test.info().project.name !== "webkit";
  await expect(page.locator(".mep-notices")).toContainText(pictured ? "Added 1 recipe with its picture." : /Added 1 recipe( with its picture)?\./);
  expect(asked).toContain("image:https://example.test/cucumber.png");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cucumber and yoghurt soup", { exact: true })).toBeVisible();
  if (pictured) await expect(page.locator(".cooking-db__cover img").filter({ hasNot: page.locator("[src^='/']") }).first()).toBeVisible();
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
  await expect(page.locator(".mep-notices")).toContainText(/Added 2 recipes(, 1 with a picture)?\./);
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();

  await openImport(page);
  const again = page.getByRole("dialog", { name: "Import from a web page" });
  await again.getByText("Page can't be fetched?").click();
  await again.getByLabel("Page HTML").fill(twoSoups);
  await again.getByRole("button", { name: "Add 2 recipes" }).click();
  await expect(again.getByRole("alert")).toContainText("already exists");
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();
});


test("page import never swaps ingredient quantities when visible numerals appear in a different order", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openFreshCookbook(page);
  const data = { ...recipe("Quantity-safe soup", ["2.0 onions, 400 g", "1.0 tbsp oil"], ["Cook the onions."]),
    "@id": "https://example.test/soup#recipe" };
  const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>
    <article id="recipe" class="wprm-recipe-container"><h1>Quantity-safe soup</h1><h2>Ingredients</h2>
    <ul><li>400 g onions, 2</li><li>1 tbsp oil</li></ul><h2>Method</h2><p>Cook the onions.</p></article>`;
  await servePages(page, { "https://example.test/soup": html });
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import from a web page" });
  await dialog.getByLabel("Page address").fill("https://example.test/soup");
  await dialog.getByRole("button", { name: "Fetch page" }).click();
  await expect(dialog.getByRole("list", { name: "Recipes found" })).toContainText("2 ingredients · 1 step");
  await dialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByText("Quantity-safe soup", { exact: true }).click();
  await expect(page.getByText("2 onions, 400 g", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/clipper-quantity-safe.png" });
  await page.reload();
  const markdown = await exportedCookbookText(page, "quantity-safe-soup.md");
  expect(markdown).toMatch(/\*2(?:\.0)?\* onions, 400 g/);
  expect(markdown).not.toContain("400 onions");
  expect(markdown).toContain("Cook the onions.");
  expect(errors).toEqual([]);
});
