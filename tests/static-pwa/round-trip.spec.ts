import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type FilePayload, type Page } from "@playwright/test";

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
  await expect(page.locator(".mep-notices")).toContainText(`Imported ${count} files; skipped 0 existing files.`);
  await page.getByTitle("Close settings").click();
}

type VisibleKitchenState = {
  recipes: Array<{ title: string; ingredientCount: number }>;
  plan: Array<{ title: string; column: string }>;
  dayNotes: Array<{ date: string; note: string }>;
  shopping: Array<{ item: string; checked: boolean }>;
};

async function collectVisibleKitchenState(page: Page): Promise<VisibleKitchenState> {
  await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
  await expect(page.getByText("2 recipes", { exact: true })).toBeVisible();
  const titles = (await page.locator(".cooking-db__title").allTextContents()).sort();
  const recipes: VisibleKitchenState["recipes"] = [];
  for (const title of titles) {
    await page.getByRole("button", { name: `Open recipe ${title}` }).click();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    recipes.push({ title, ingredientCount: await page.locator(".recipe-view__ingredients-panel li").count() });
    await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
    await expect(page.getByText("2 recipes", { exact: true })).toBeVisible();
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

test("a zip export imports into a new kitchen without losing visible cooking state", async ({ page, browser }) => {
  const monday = currentMonday();
  await openEmptyKitchen(page);
  await importFiles(page, [
    {
      name: "round-trip-soup.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("---\ntitle: Round Trip Soup\n---\n\n# Round Trip Soup\n\n## Ingredients\n- 2 onions\n- 1 litre stock\n- black pepper\n\n## Method\n1. Simmer.\n"),
    },
    {
      name: "round-trip-pie.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("---\ntitle: Round Trip Pie\n---\n\n# Round Trip Pie\n\n## Ingredients\n- pastry\n- 3 apples\n\n## Method\n1. Bake.\n"),
    },
    {
      name: "Plan.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(`## Marked\n- [[round-trip-soup]]\n\n## ${monday}\n> Pick up the veg box\n- [[round-trip-pie]]\n`),
    },
    {
      name: "Shopping.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Shopping\n\n## Other\n- [ ] fresh basil\n- [x] olive oil\n"),
    },
  ], 4);

  const sourceState = await collectVisibleKitchenState(page);
  expect(sourceState).toEqual({
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
      { item: "fresh basil", checked: false },
      { item: "olive oil", checked: true },
    ],
  });

  await openSettings(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download kitchen (.zip)" }).click();
  const download = await downloadPromise;
  const zipPath = await download.path();
  expect(zipPath).not.toBeNull();

  const targetContext = await browser.newContext();
  const target = await targetContext.newPage();
  try {
    await openEmptyKitchen(target);
    await importFiles(target, {
      name: "enplace-kitchen.zip",
      mimeType: "application/zip",
      buffer: await readFile(zipPath!),
    }, 4);
    expect(await collectVisibleKitchenState(target)).toEqual(sourceState);
  } finally {
    await targetContext.close();
  }
});
