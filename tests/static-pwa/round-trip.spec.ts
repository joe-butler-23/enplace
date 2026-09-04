import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type FilePayload, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function newKitchenId(): string {
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

async function openEmptyKitchen(page: Page): Promise<void> {
  const id = newKitchenId();
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
  const input = page.locator(".mep-kitchen-panel__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles(files);
  await expect(page.locator(".mep-notices")).toContainText(`Imported ${count} file${count === 1 ? "" : "s"}; skipped 0 existing files.`);
  await page.getByTitle("Close settings").click();
}

type VisibleKitchenState = {
  recipes: Array<{ title: string; ingredientCount: number }>;
  plan: Array<{ title: string; column: string }>;
  dayNotes: Array<{ date: string; note: string }>;
  shopping: Array<{ item: string; checked: boolean }>;
};

async function collectVisibleKitchenState(page: Page, recipeCount = 2): Promise<VisibleKitchenState> {
  await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
  await expect(page.getByText(`${recipeCount} recipes`, { exact: true })).toBeVisible();
  const titles = (await page.locator(".cooking-db__title").allTextContents()).sort();
  const recipes: VisibleKitchenState["recipes"] = [];
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
  const id = newKitchenId();
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
  const initial = await collectVisibleKitchenState(page);
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
  const beforeOffline = await collectVisibleKitchenState(page);
  expect(beforeOffline.shopping).toEqual([
    { item: "fresh basil", checked: false }, { item: "olive oil", checked: true },
    { item: "pastry", checked: false }, { item: "3 apples", checked: false },
  ]);

  const rightContext = await browser.newContext();
  const right = await rightContext.newPage();
  try {
    await right.goto(`/#k=${id}`);
    expect(await collectVisibleKitchenState(right)).toEqual(beforeOffline);
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
      buffer: Buffer.from(zipSync({ "images/blocked.png": new Uint8Array([9]) })),
    }, 1);
    await page.getByLabel("Recipe title").fill("Blocked");
    await page.getByLabel("Recipe ingredients").fill("onion");
    await page.getByLabel("Recipe method").fill("Simmer");
    await page.getByLabel("Recipe cover image").setInputFiles({
      name: "blocked.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]),
    });
    await page.getByRole("button", { name: "Import recipe" }).click();
    await expect(page.getByRole("alert")).toContainText("images/blocked.png");
    await page.getByLabel("Recipe title").fill("Recipes");
    await page.getByRole("button", { name: "Import recipe" }).click();
    await expect(page.getByRole("button", { name: "Open recipe Recipes" })).toBeVisible();
    await expect(page.evaluate(() => document.documentElement.dataset.testToken)).resolves.toBe(documentToken);
    await importFiles(right, {
      name: "child.zip", mimeType: "application/zip",
      buffer: Buffer.from(zipSync({ "recipes.md/nested/cover.webp": new Uint8Array([0, 255, 7]) })),
    }, 1);
    await rightContext.setOffline(false);
    await page.context().setOffline(false);
    await expect(page.locator('.cooking-db__card[data-path="recipes (file conflict 0ed49ba7).md"]')).toBeVisible();

    const source = await collectVisibleKitchenState(page, 3);
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
    await page.getByRole("button", { name: "Download kitchen (.zip)" }).click();
    const exportedPath = await (await download).path();
    const exported = unzipSync(await readFile(exportedPath!));
    const renamed = "recipes (file conflict 0ed49ba7).md";
    expect(Object.keys(exported).sort()).toEqual([
      "Plan.md", "Shopping.md", "images/blocked.png", "images/recipes.png", renamed,
      "recipes.md/nested/cover.webp", "round-trip-pie.md", "round-trip-soup.md",
    ]);
    expect(exported["blocked.md"]).toBeUndefined();
    expect(new TextDecoder().decode(exported[renamed])).toContain("# Recipes");
    expect(exported["images/recipes.png"]).toEqual(new Uint8Array([1, 2, 3]));

    const targetContext = await browser.newContext();
    const target = await targetContext.newPage();
    try {
      await openEmptyKitchen(target);
      await importFiles(target, {
        name: "kitchen.zip", mimeType: "application/zip", buffer: await readFile(exportedPath!),
      }, 8);
      expect(await collectVisibleKitchenState(target, 3)).toEqual(source);
    } finally { await targetContext.close(); }
  } finally { await rightContext.close(); }
});
