import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeCookbookText } from "../../src/cookbook/doc";
import { createEmptyCookbookConnection, exportedCookbookText, openFreshCookbook, openShopping } from "./helpers";

// Page/image fixtures stay local and must not be swallowed by the app-shell worker.
test.use({ serviceWorkers: "block" });

const FIRST = "2032-04-05T10:00:00.100Z";
const SECOND = "2032-04-05T10:00:00.900Z";
const recipeMarkdown = (title: string) => `# ${title}

---

- *200 g* lentils
- *500 ml* stock

---

1. Simmer until tender.
`;
const recipePath = (title: string) => `${title.toLowerCase().replaceAll(" ", "-")}.md`;

function addedTimestamp(markdown: string): string {
  const stamps = [...markdown.matchAll(/^Added: (.+)$/gm)];
  expect(stamps).toHaveLength(1);
  const value = stamps[0][1];
  expect(Number.isFinite(Date.parse(value))).toBe(true);
  return value;
}

async function addRecipe(page: Page, mode: "Web page" | "Markdown" | "File", title: string): Promise<void> {
  await page.getByRole("button", { name: "Add recipe", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add recipe", exact: true });
  await expect(dialog).toBeVisible();
  if (mode === "Web page") {
    await dialog.getByLabel("Page address").fill(`https://example.test/${encodeURIComponent(title)}`);
    await dialog.getByRole("button", { name: "Fetch page" }).click();
    await expect(dialog.getByRole("list", { name: "Recipes found" })).toContainText(title);
  } else {
    await dialog.getByRole("button", { name: mode, exact: true }).click();
    if (mode === "File") {
      await dialog.getByLabel("Recipe Markdown file").setInputFiles({
        name: recipePath(title), mimeType: "text/markdown", buffer: Buffer.from(recipeMarkdown(title)),
      });
      await expect(dialog.getByLabel("Recipe Markdown", { exact: true })).toHaveValue(recipeMarkdown(title));
    } else await dialog.getByLabel("Recipe Markdown", { exact: true }).fill(recipeMarkdown(title));
  }
  await dialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: `Open recipe ${title}`, exact: true })).toBeVisible();
}

for (const mode of ["Web page", "Markdown", "File"] as const) {
  test(`${mode} imports sort by their full same-day arrival times locally and on a shared device`, async ({ page, browser }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // setFixedTime controls Date without pausing network, persistence, or rendering timers.
    await page.clock.setFixedTime(new Date(FIRST));
    const id = await openFreshCookbook(page);
    if (mode === "Web page") await page.route(/\/page\?url=/, (route) => {
      const url = new URL(new URL(route.request().url()).searchParams.get("url")!);
      const recipe = {
        "@context": "https://schema.org", "@type": "Recipe", name: decodeURIComponent(url.pathname.slice(1)),
        recipeIngredient: ["200g lentils", "500ml stock"],
        recipeInstructions: [{ "@type": "HowToStep", text: "Simmer until tender." }],
      };
      return route.fulfill({ status: 200, contentType: "text/html", body: `<script type="application/ld+json">${JSON.stringify(recipe)}</script>` });
    });
    const first = `Alpha ${mode} lentils`;
    const second = `Zulu ${mode} lentils`;
    await addRecipe(page, mode, first);
    await expect(page.locator(".cooking-db__title").first()).toHaveText(first);
    const partnerContext = await browser.newContext({ serviceWorkers: "block" });
    const partner = await partnerContext.newPage();
    partner.on("pageerror", (error) => errors.push(error.message));
    try {
      await partner.goto(`/#k=${id}`);
      await expect(partner.locator(".cooking-db__title").first()).toHaveText(first);
      await page.clock.setFixedTime(new Date(SECOND));
      await addRecipe(page, mode, second);
      for (const current of [page, partner]) {
        await expect(current.locator(".cooking-db__title").nth(0)).toHaveText(second);
        await expect(current.locator(".cooking-db__title").nth(1)).toHaveText(first);
        await expect(current.getByText("13 recipes", { exact: true })).toBeVisible();
      }
      await page.reload();
      await partner.reload();
      for (const current of [page, partner]) {
        await expect(current.locator(".cooking-db__title").nth(0)).toHaveText(second);
        await expect(current.locator(".cooking-db__title").nth(1)).toHaveText(first);
      }
      for (const [title, time] of [[first, FIRST], [second, SECOND]]) {
        const exported = await exportedCookbookText(page, recipePath(title));
        expect(addedTimestamp(exported)).toBe(time);
        if (mode !== "Web page") expect(exported.replace(`Added: ${time}\n\n`, "")).toBe(recipeMarkdown(title));
        expect(await exportedCookbookText(partner, recipePath(title))).toBe(exported);
      }
      expect(errors).toEqual([]);
    } finally { await partnerContext.close(); }
  });
}

async function fabAppearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      style: Object.fromEntries(["position", "right", "bottom", "width", "height", "border-radius", "background-color", "color", "font-size", "box-shadow"].map((name) => [name, style.getPropertyValue(name)])),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  test(`Recipe Database and Shopping use the same floating plus on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openFreshCookbook(page);
    await page.mouse.move(1, 1);
    const recipeAdd = page.getByRole("button", { name: "Add recipe", exact: true });
    await expect(recipeAdd).toHaveCount(1);
    await expect(recipeAdd).toHaveClass("mep-fab");
    await expect(recipeAdd).toHaveText("+");
    const database = await fabAppearance(recipeAdd);
    await page.screenshot({ path: testInfo.outputPath(`database-plus-${viewport.name}.png`) });
    await recipeAdd.click();
    await expect(page.getByRole("dialog", { name: "Add recipe" })).toBeVisible();
    await expect(page.getByLabel("Page address")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(recipeAdd).toBeFocused();

    await openShopping(page);
    await page.mouse.move(1, 1);
    const shoppingAdd = page.getByRole("button", { name: "Add an item", exact: true });
    await expect(shoppingAdd).toHaveClass("mep-fab");
    await expect(shoppingAdd).toHaveText("+");
    const shopping = await fabAppearance(shoppingAdd);
    expect(database.style).toEqual(shopping.style);
    for (const { bounds } of [database, shopping]) {
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBe(bounds.width);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThan(viewport.height / 2);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.screenshot({ path: testInfo.outputPath(`shopping-plus-${viewport.name}.png`) });
    await shoppingAdd.click();
    await expect(page.getByLabel("Add a shopping item")).toBeFocused();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove sample recipes", exact: true }).click();
    await expect(page.locator(".mep-notices")).toContainText("Removed sample recipes.");
    await page.getByTitle("Close settings").click();
    await expect(page.getByRole("heading", { name: "No recipes yet", exact: true })).toBeVisible();
    await expect(recipeAdd).toHaveCount(1);
    await expect(recipeAdd).toHaveClass("mep-fab");
    await recipeAdd.click();
    await expect(page.getByRole("dialog", { name: "Add recipe" })).toBeVisible();
    await expect(page.getByLabel("Page address")).toBeFocused();
  });
}

async function editRecipe(page: Page, title: string, markdown: string): Promise<void> {
  await page.getByRole("button", { name: `Open recipe ${title}`, exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Recipe markdown", { exact: true }).fill(markdown);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
  await expect(page.getByRole("button", { name: `Open recipe ${title}`, exact: true })).toBeVisible();
}

test("Settings stamps new recipes but preserves supplied dates and never redates edits or legacy recipes", async ({ page }) => {
  const connection = await createEmptyCookbookConnection();
  const legacy = recipeMarkdown("Old undated lentils");
  // This is pre-existing document state, not a new import through today's stamping boundary.
  writeCookbookText(connection.doc, "old-undated-lentils.md", legacy);
  const now = "2032-04-05T11:00:00.123Z";
  const supplied = "2032-04-05T12:00:00+02:00"; // 10:00Z: string order and chronological order disagree.
  const preserved = recipeMarkdown("Alpha preserved lentils").replace("\n\n---", `\n\nAdded: ${supplied}\n\n---`);
  const fresh = recipeMarkdown("Zulu settings lentils");
  try {
    await page.clock.setFixedTime(new Date(now));
    await page.goto(`/#k=${connection.id}`);
    await expect(page.getByRole("button", { name: "Open recipe Old undated lentils", exact: true })).toBeVisible();
    expect(await exportedCookbookText(page, "old-undated-lentils.md")).toBe(legacy);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".mep-settings__file-button", { hasText: "Import files" }).locator('input[type="file"]').setInputFiles([
      { name: "alpha-preserved-lentils.md", mimeType: "text/markdown", buffer: Buffer.from(preserved) },
      { name: "zulu-settings-lentils.md", mimeType: "text/markdown", buffer: Buffer.from(fresh) },
    ]);
    await expect(page.locator(".mep-notices")).toContainText("Imported 2 files; skipped 0 existing files. 2 recipes recognised.");
    await page.getByTitle("Close settings").click();
    const order = ["Zulu settings lentils", "Alpha preserved lentils", "Old undated lentils"];
    await expect(page.locator(".cooking-db__title")).toHaveText(order);
    const imported = await exportedCookbookText(page, "zulu-settings-lentils.md");
    expect(addedTimestamp(imported)).toBe(now);
    expect(imported.replace(`Added: ${now}\n\n`, "")).toBe(fresh);
    expect(await exportedCookbookText(page, "alpha-preserved-lentils.md")).toBe(preserved);

    await page.clock.setFixedTime(new Date("2033-06-01T14:00:00.000Z"));
    const edited = imported.replace("Simmer until tender.", "Simmer gently until tender.").trimEnd();
    const editedLegacy = legacy.replace("Simmer until tender.", "Simmer gently until tender.").trimEnd();
    await editRecipe(page, "Zulu settings lentils", edited);
    await editRecipe(page, "Old undated lentils", editedLegacy);
    await page.reload();
    await expect(page.locator(".cooking-db__title")).toHaveText(order);
    expect(await exportedCookbookText(page, "zulu-settings-lentils.md")).toBe(edited);
    expect(await exportedCookbookText(page, "alpha-preserved-lentils.md")).toBe(preserved);
    expect(await exportedCookbookText(page, "old-undated-lentils.md")).toBe(editedLegacy);
    expect(editedLegacy).not.toMatch(/^Added:/m);
  } finally { await connection.close(); }
});
