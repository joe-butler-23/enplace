import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type FilePayload, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const COVER_PNG = Buffer.from("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", "base64");

function newCookbookId(): string {
  return Array.from(randomBytes(26), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

function localIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonday(): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localIso(date);
}

async function openEmptyCookbook(page: Page): Promise<void> {
  const id = newCookbookId();
  await page.goto(`/#k=${id}`);
  await expect(page).toHaveURL(new RegExp(`#k=${id}$`));
  await expect(page.getByRole("heading", { name: "No recipes yet" })).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

async function importFiles(page: Page, files: string | string[] | FilePayload | FilePayload[], count: number): Promise<void> {
  await openSettings(page);
  const input = page.locator(".mep-settings__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles(files);
  await expect(page.locator(".mep-notices")).toContainText(`Imported ${count} file${count === 1 ? "" : "s"}; skipped 0 existing files.`);
  await page.getByTitle("Close settings").click();
}

type VisibleCookbookState = {
  recipes: Array<{ title: string; ingredientCount: number }>;
  plan: Array<{ title: string; column: string }>;
  dayNotes: Array<{ date: string; note: string }>;
  shopping: Array<{ item: string; checked: boolean }>;
};

async function collectVisibleCookbookState(page: Page, recipeCount = 2): Promise<VisibleCookbookState> {
  await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
  await expect(page.getByText(`${recipeCount} recipes`, { exact: true })).toBeVisible();
  const titles = (await page.locator(".cooking-db__title").allTextContents()).sort();
  const recipes: VisibleCookbookState["recipes"] = [];
  for (const title of titles) {
    await page.getByRole("button", { name: `Open recipe ${title}` }).click();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    recipes.push({ title, ingredientCount: await page.locator(".recipe-view__ingredients-panel li").count() });
    await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
    await expect(page.getByText(`${recipeCount} recipes`, { exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "Planner", exact: true }).click();
  const cards = page.locator(".kanban-item");
  await expect(cards).toHaveCount(2);
  const plan = await cards.evaluateAll((nodes) => nodes.map((node) => ({
    title: node.querySelector(".card-title")?.textContent?.trim() ?? "",
    column: node.closest(".kanban-board")?.getAttribute("data-id") ?? "",
  })).sort((left, right) => left.title.localeCompare(right.title)));
  const dayNotes = await page.locator(".organiser-column-note.has-note").evaluateAll((nodes) => nodes.map((node) => ({
    date: (node as HTMLElement).dataset.date ?? "",
    note: node.textContent?.trim() ?? "",
  })));

  await page.getByRole("button", { name: "Shopping List", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shopping list" })).toBeVisible();
  const shopping = await page.locator(".shopping-item").evaluateAll((nodes) => nodes.map((node) => ({
    item: node.querySelector(".shopping-item__name")?.textContent?.trim() ?? "",
    checked: (node.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked ?? false,
  })));
  return { recipes, plan, dayNotes, shopping };
}

test("offline paste and a disconnected path collision survive visible ZIP round-trip", async ({ page, browser, browserName }) => {
  test.skip(browserName === "webkit", "WebKit cannot read Playwright-injected files while the context is offline");
  const monday = currentMonday();
  const id = newCookbookId();
  await page.goto(`/#k=${id}`);
  await importFiles(page, [
    {
      name: "round-trip-soup.md", mimeType: "text/markdown",
      buffer: Buffer.from("---\ntitle: Round Trip Soup\n---\n\n# Round Trip Soup\n\n## Ingredients\n- 2 onions\n- 1 litre stock\n- black pepper\n\n## Method\n1. Simmer.\n"),
    },
    {
      name: "round-trip-pie.md", mimeType: "text/markdown",
      buffer: Buffer.from("---\ntitle: Round Trip Pie\n---\n\n# Round Trip Pie\n\n## Ingredients\n- pastry\n- 3 apples\n\n## Method\n1. Bake.\n"),
    },
    {
      name: "Plan.md", mimeType: "text/markdown",
      buffer: Buffer.from(`## Marked\n- [[round-trip-soup]]\n\n## ${monday}\n> Pick up the veg box\n- [[round-trip-pie]]\n`),
    },
    {
      name: "Shopping.md", mimeType: "text/markdown",
      buffer: Buffer.from("# Shopping\n\n## Other\n- [ ] fresh basil\n- [x] olive oil\n"),
    },
  ], 4);
  const initial = await collectVisibleCookbookState(page);
  expect(initial).toEqual({
    recipes: [
      { title: "Round Trip Pie", ingredientCount: 2 },
      { title: "Round Trip Soup", ingredientCount: 3 },
    ],
    plan: [
      { title: "Round Trip Pie", column: monday },
      { title: "Round Trip Soup", column: "marked" },
    ],
    dayNotes: [{ date: monday, note: "Pick up the veg box" }],
    shopping: [
      { item: "fresh basil", checked: false }, { item: "olive oil", checked: true },
    ],
  });
  await page.getByRole("button", { name: "Planner", exact: true }).click();
  await page.getByRole("button", { name: "Build shopping list" }).click();
  await expect(page).toHaveURL(/\/shopping#k=/);
  const beforeOffline = await collectVisibleCookbookState(page);
  expect(beforeOffline.shopping).toEqual([
    { item: "fresh basil", checked: false }, { item: "olive oil", checked: true },
    { item: "pastry", checked: false }, { item: "3 apples", checked: false },
  ]);

  const rightContext = await browser.newContext();
  const right = await rightContext.newPage();
  try {
    await right.goto(`/#k=${id}`);
    expect(await collectVisibleCookbookState(right)).toEqual(beforeOffline);
    await page.goto(`/?share-target#k=${id}`);
    await expect(page.getByLabel("Recipe title")).toBeVisible();
    const documentToken = await page.evaluate(() => (document.documentElement.dataset.testToken = crypto.randomUUID()));
    await page.context().setOffline(true);
    await rightContext.setOffline(true);
    await expect(page.evaluate(() => navigator.onLine)).resolves.toBe(false);
    await expect(right.evaluate(() => navigator.onLine)).resolves.toBe(false);
    await expect(right.getByText("Offline. Your ticks are saved on this phone.", { exact: true })).toBeVisible();
    await right.reload();
    await expect(right.getByRole("checkbox", { name: "fresh basil" })).toBeVisible();
    await expect(right.getByText("Offline. Your ticks are saved on this phone.", { exact: true })).toBeVisible();
    await importFiles(page, {
      name: "existing.zip", mimeType: "application/zip",
      buffer: Buffer.from(zipSync({ "images/blocked.webp": new Uint8Array([9]) })),
    }, 1);
    await page.getByLabel("Recipe title").fill("Blocked");
    await page.getByLabel("Recipe ingredients").fill("onion");
    await page.getByLabel("Recipe method").fill("Simmer");
    await page.getByLabel("Recipe cover image").setInputFiles({
      name: "blocked.png", mimeType: "image/png", buffer: COVER_PNG,
    });
    await page.getByRole("button", { name: "Import recipe" }).click();
    await expect(page.getByRole("alert")).toContainText("images/blocked.webp");
    await page.getByLabel("Recipe title").fill("Recipes");
    await page.getByRole("button", { name: "Import recipe" }).click();
    const importedOpen = page.getByRole("button", { name: "Open recipe Recipes" });
    const importedCard = importedOpen.locator("..");
    await expect(importedOpen).toBeVisible();
    await expect(importedCard.locator("img")).toHaveJSProperty("naturalWidth", 448);
    await expect(importedCard.locator("img")).toHaveJSProperty("naturalHeight", 448);
    await importedOpen.click();
    await expect(page.locator(".recipe-view__hero img")).toHaveJSProperty("naturalWidth", 800);
    await expect(page.locator(".recipe-view__hero img")).toHaveJSProperty("naturalHeight", 400);
    await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
    await expect(page.evaluate(() => document.documentElement.dataset.testToken)).resolves.toBe(documentToken);
    await importFiles(right, {
      name: "child.zip", mimeType: "application/zip",
      buffer: Buffer.from(zipSync({ "recipes.md/nested/cover.webp": new Uint8Array([0, 255, 7]) })),
    }, 1);
    await rightContext.setOffline(false);
    await page.context().setOffline(false);
    await expect(page.locator('.cooking-db__card[data-path="recipes (file conflict 0ed49ba7).md"]')).toBeVisible();

    const source = await collectVisibleCookbookState(page, 3);
    expect(source).toEqual({
      ...initial,
      recipes: [
        { title: "Recipes", ingredientCount: 1 },
        { title: "Round Trip Pie", ingredientCount: 2 },
        { title: "Round Trip Soup", ingredientCount: 3 },
      ],
      shopping: [
        { item: "fresh basil", checked: false }, { item: "olive oil", checked: true },
        { item: "pastry", checked: false }, { item: "3 apples", checked: false },
      ],
    });
    await openSettings(page);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download cookbook (.zip)" }).click();
    const exportedPath = await (await download).path();
    const exported = unzipSync(await readFile(exportedPath!));
    const renamed = "recipes (file conflict 0ed49ba7).md";
    expect(Object.keys(exported).sort()).toEqual([
      "Plan.md", "Shopping.md", "images/blocked.webp", "images/recipes.card.webp", "images/recipes.webp", renamed,
      "recipes.md/nested/cover.webp", "round-trip-pie.md", "round-trip-soup.md",
    ]);
    expect(exported["blocked.md"]).toBeUndefined();
    expect(new TextDecoder().decode(exported[renamed])).toContain("# Recipes");
    expect(exported["images/recipes.webp"]).not.toEqual(COVER_PNG);
    expect(exported["images/recipes.card.webp"].byteLength).toBeGreaterThan(0);

    const targetContext = await browser.newContext();
    const target = await targetContext.newPage();
    try {
      await openEmptyCookbook(target);
      await importFiles(target, {
        name: "cookbook.zip", mimeType: "application/zip", buffer: await readFile(exportedPath!),
      }, 9);
      expect(await collectVisibleCookbookState(target, 3)).toEqual(source);
    } finally { await targetContext.close(); }
  } finally { await rightContext.close(); }
});
