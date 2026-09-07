import { expect, test, type Locator, type Page } from "@playwright/test";
import { exportedCookbookText, openFreshCookbook } from "./helpers";

const markdown = (title: string) => `# ${title}

---

- *200 g* lentils
- *500 ml* stock

---

1. Simmer until tender.
`;

async function openAddRecipe(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Add recipe", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add recipe", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(dialog.getByLabel("Page address")).toBeFocused();
  return dialog;
}

async function expectMode(dialog: Locator, mode: "Web page" | "Markdown" | "File"): Promise<void> {
  for (const name of ["Web page", "Markdown", "File"]) {
    await expect(dialog.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", String(name === mode));
  }
  if (mode === "Web page") {
    await expect(dialog.getByLabel("Page address")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Fetch page" })).toBeVisible();
    await expect(dialog.getByLabel("Recipe Markdown", { exact: true })).toBeHidden();
    await expect(dialog.getByLabel("Recipe cover image")).toBeHidden();
  } else {
    await expect(dialog.getByLabel("Page address")).toBeHidden();
    await expect(dialog.getByRole("button", { name: "Fetch page" })).toBeHidden();
    await expect(dialog.getByLabel("Page HTML")).toBeHidden();
    await expect(dialog.getByLabel("Recipe Markdown", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Recipe cover image")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add recipe", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  }
  if (mode === "File") await expect(dialog.getByLabel("Recipe Markdown file")).toBeVisible();
  else await expect(dialog.getByLabel("Recipe Markdown file")).toBeHidden();
}

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
  test(`Add recipe is one focused popup over the unchanged database on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFreshCookbook(page);
    const trigger = page.getByRole("button", { name: "Add recipe", exact: true }).first();
    const grid = page.locator(".cooking-db__grid");
    const originalGrid = await grid.elementHandle();
    expect(originalGrid).not.toBeNull();
    const titles = await grid.locator(".cooking-db__title").allTextContents();
    const dialog = await openAddRecipe(page);
    await expectMode(dialog, "Web page");
    await expect(grid).toBeVisible();
    await expect(grid.locator(".cooking-db__card")).toHaveCount(11);
    expect(await grid.locator(".cooking-db__title").allTextContents()).toEqual(titles);
    expect(await grid.evaluate((current, original) => current === original, originalGrid)).toBe(true);
    await expect(dialog.getByRole("button", { name: "Import from a web page", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Close add recipe", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close settings", exact: true })).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`add-recipe-${viewport.name}-web.png`) });

    await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
    await expectMode(dialog, "Markdown");
    const draft = markdown("Unsubmitted lentils");
    await dialog.getByLabel("Recipe Markdown", { exact: true }).fill(draft);
    await page.screenshot({ path: testInfo.outputPath(`add-recipe-${viewport.name}-markdown.png`) });
    await dialog.getByRole("button", { name: "File", exact: true }).click();
    await expectMode(dialog, "File");
    await expect(dialog.getByLabel("Recipe Markdown", { exact: true })).toHaveValue(draft);
    await page.screenshot({ path: testInfo.outputPath(`add-recipe-${viewport.name}-file.png`) });
    await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
    await expectMode(dialog, "Markdown");
    await expect(dialog.getByLabel("Recipe Markdown", { exact: true })).toHaveValue(draft);
    await dialog.getByRole("button", { name: "Web page", exact: true }).click();
    await expectMode(dialog, "Web page");
    await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
    await expect(dialog.getByLabel("Recipe Markdown", { exact: true })).toHaveValue(draft);

    // Every dismissal restores the actual invoking button; every new session starts on Web page.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    for (const close of ["button", "backdrop", "cancel"] as const) {
      const reopened = await openAddRecipe(page);
      await expectMode(reopened, "Web page");
      if (close === "button") await reopened.getByRole("button", { name: "Close add recipe", exact: true }).click();
      else if (close === "backdrop") {
        const rect = await reopened.boundingBox();
        expect(rect!.y).toBeGreaterThan(1);
        await page.mouse.click(1, 1);
      } else {
        await reopened.getByRole("button", { name: "Markdown", exact: true }).click();
        await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
      }
      await expect(reopened).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    expect(await originalGrid!.evaluate((element) => element.isConnected)).toBe(true);
    await expect(grid.locator(".cooking-db__card")).toHaveCount(11);
    expect(errors).toEqual([]);
  });
}

test("Markdown errors can be corrected and file contents are reviewed before durable import", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openFreshCookbook(page);
  const dialog = await openAddRecipe(page);
  await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
  const draft = dialog.getByLabel("Recipe Markdown", { exact: true });
  const invalid = "# Market notes\n\nRemember the lentils.\n";
  await draft.fill(invalid);
  await dialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("This Markdown does not look like a recipe");
  await expect(draft).toHaveValue(invalid);
  await expect(page.locator(".cooking-db__card")).toHaveCount(11);
  await draft.fill(markdown("Corrected lentils"));
  await dialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open recipe Corrected lentils", exact: true })).toBeVisible();

  const fileDialog = await openAddRecipe(page);
  await expect(fileDialog.getByRole("alert")).toHaveCount(0);
  await fileDialog.getByRole("button", { name: "File", exact: true }).click();
  const fileMarkdown = markdown("File lentils");
  await fileDialog.getByLabel("Recipe Markdown file").setInputFiles({
    name: "file-lentils.md", mimeType: "text/markdown", buffer: Buffer.from(fileMarkdown),
  });
  const review = fileDialog.getByLabel("Recipe Markdown", { exact: true });
  await expect(review).toHaveValue(fileMarkdown);
  await expect(fileDialog).toBeVisible();
  await expect(page.locator(".cooking-db__card")).toHaveCount(12);
  const reviewed = fileMarkdown.replace("File lentils", "Reviewed file lentils").replace("Simmer until tender.", "Simmer for 20 minutes.");
  await review.fill(reviewed);
  await fileDialog.getByRole("button", { name: "Add recipe", exact: true }).click();
  await expect(fileDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open recipe Reviewed file lentils", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Open recipe Corrected lentils", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open recipe Reviewed file lentils", exact: true })).toBeVisible();
  await expect(page.getByText("13 recipes", { exact: true })).toBeVisible();
  expect(await exportedCookbookText(page, "corrected-lentils.md")).toBe(markdown("Corrected lentils"));
  expect(await exportedCookbookText(page, "reviewed-file-lentils.md")).toBe(reviewed);
  expect(errors).toEqual([]);
});


test.describe("pending web import", () => {
  // The relay responses must reach these routes rather than the app-shell service worker.
  test.use({ serviceWorkers: "block" });

  test("completion from a dismissed import does not close a newly opened Add recipe popup", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openFreshCookbook(page);
    const recipe = {
      "@context": "https://schema.org", "@type": "Recipe", name: "Delayed picture lentils",
      recipeIngredient: ["200g lentils", "500ml stock"],
      recipeInstructions: [{ "@type": "HowToStep", text: "Simmer until tender." }],
      image: "https://example.test/delayed-lentils.png",
    };
    await page.route(/\/page\?url=/, (route) => route.fulfill({
      status: 200, contentType: "text/html",
      body: `<script type="application/ld+json">${JSON.stringify(recipe)}</script>`,
    }));
    let releaseImage!: () => void;
    const imageGate = new Promise<void>((resolve) => { releaseImage = resolve; });
    await page.route(/\/image\?url=/, async (route) => {
      await imageGate;
      await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64",
      ) });
    });
    try {
      const oldDialog = await openAddRecipe(page);
      await oldDialog.getByLabel("Page address").fill("https://example.test/delayed-lentils");
      await oldDialog.getByRole("button", { name: "Fetch page" }).click();
      await expect(oldDialog.getByRole("list", { name: "Recipes found" })).toContainText("Delayed picture lentils");
      const imageRequested = page.waitForRequest(/\/image\?url=/);
      await oldDialog.getByRole("button", { name: "Add recipe", exact: true }).click();
      await imageRequested;
      await oldDialog.getByRole("button", { name: "Close add recipe", exact: true }).click();
      await expect(oldDialog).toBeHidden();
      const reopened = await openAddRecipe(page);
      await reopened.getByRole("button", { name: "Markdown", exact: true }).click();
      const newDraft = markdown("Next recipe draft");
      await reopened.getByLabel("Recipe Markdown", { exact: true }).fill(newDraft);
      releaseImage();
      // Observe completion, not elapsed time, before checking that the new session survived.
      await expect(page.locator(".mep-notices")).toContainText(/Added 1 recipe/);
      await expect(page.locator(".cooking-db__title").filter({ hasText: "Delayed picture lentils" })).toHaveCount(1);
      await expect(reopened).toBeVisible();
      await expectMode(reopened, "Markdown");
      await expect(reopened.getByLabel("Recipe Markdown", { exact: true })).toHaveValue(newDraft);
      expect(errors).toEqual([]);
    } finally {
      releaseImage();
    }
  });
});
