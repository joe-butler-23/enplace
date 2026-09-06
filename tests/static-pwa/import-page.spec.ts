import { openFreshCookbook } from "./helpers";
import { expect, test } from "@playwright/test";

const recipe = (name: string, ingredients: string[], steps: string[]) => ({
  "@context": "https://schema.org", "@type": "Recipe", name, recipeIngredient: ingredients, recipeYield: "2 servings",
  recipeInstructions: steps.map((text) => ({ "@type": "HowToStep", text })),
});
const twoSoups = `<!doctype html><html><head><title>Two chilled soups</title>
<script type="application/ld+json">${JSON.stringify([
  recipe("Cucumber and yoghurt soup", ["1 cucumber", "100g greek yoghurt"], ["Blend everything.", "Chill and serve."]),
  recipe("Watermelon gazpacho", ["250g watermelon flesh", "800g ripe tomatoes"], ["Blitz until smooth."]),
]).replaceAll("<", "\\u003c")}</script></head><body><h1>Two chilled soups</h1></body></html>`;

test("Import from a web page lists every recipe and adds only the chosen ones", async ({ page }) => {
  await openFreshCookbook(page);
  await page.getByRole("button", { name: "Add recipe", exact: true }).first().click();
  await page.getByRole("button", { name: "import from a web page" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from a web page" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Page address").fill("https://example.test/two-soups");
  await dialog.getByLabel("Saved page file").setInputFiles({ name: "two-soups.html", mimeType: "text/html", buffer: Buffer.from(twoSoups) });
  const found = dialog.getByRole("list", { name: "Recipes found" }).getByRole("listitem");
  await expect(found).toHaveCount(2);
  await expect(found.nth(0)).toContainText("Cucumber and yoghurt soup");
  await expect(found.nth(0)).toContainText("2 ingredients · 2 steps");
  await expect(found.nth(1)).toContainText("Watermelon gazpacho");
  await expect(dialog.getByRole("button", { name: "Add 2 recipes" })).toBeEnabled();
  await found.nth(1).getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(page.locator(".mep-notices")).toContainText("Added 1 recipe.");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cucumber and yoghurt soup", { exact: true })).toBeVisible();
  await expect(page.getByText("Watermelon gazpacho", { exact: true })).toHaveCount(0);
  await expect(page.getByText("12 recipes", { exact: true })).toBeVisible();
});

test("Import from a web page keeps an existing recipe file and reports the skip", async ({ page }) => {
  await openFreshCookbook(page);
  await page.getByRole("button", { name: "Add recipe", exact: true }).first().click();
  await page.getByRole("button", { name: "import from a web page" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from a web page" });
  await dialog.getByLabel("Page HTML").fill(twoSoups);
  await dialog.getByRole("button", { name: "Add 2 recipes" }).click();
  await expect(page.locator(".mep-notices")).toContainText("Added 2 recipes.");
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add recipe", exact: true }).first().click();
  await page.getByRole("button", { name: "import from a web page" }).click();
  const again = page.getByRole("dialog", { name: "Import from a web page" });
  await again.getByLabel("Page HTML").fill(twoSoups);
  await again.getByRole("button", { name: "Add 2 recipes" }).click();
  await expect(again.getByRole("alert")).toContainText("already exists");
  await expect(again).toBeVisible();
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();
});
