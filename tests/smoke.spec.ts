import { expect, test } from "@playwright/test";

/**
 * Comprehensive smoke tests that navigate through all views
 * and capture ALL console errors before the user ever sees them.
 * 
 * These tests are designed to catch:
 * - JavaScript runtime errors
 * - Failed network requests
 * - Failed image loads
 * - React rendering errors
 * - Any console.error() calls
 */

type CollectedError = {
  type: "console" | "pageerror" | "request" | "image";
  message: string;
  url?: string;
};

const createErrorCollector = (page: import("@playwright/test").Page) => {
  const errors: CollectedError[] = [];
  const warnings: string[] = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      // Filter out known benign errors
      if (text.includes("ResizeObserver loop") || text.includes("favicon.ico")) {
        return;
      }
      errors.push({ type: "console", message: text });
      console.error(`[console ERROR] ${text}`);
    } else if (msg.type() === "warning") {
      // Catch moment.js deprecation warnings as errors - they indicate bugs
      if (text.includes("Deprecation warning") || text.includes("moment construction falls back")) {
        errors.push({ type: "console", message: `[WARNING treated as error] ${text}` });
        console.error(`[console WARNING->ERROR] ${text}`);
      } else {
        warnings.push(text);
      }
    }
  });

  page.on("pageerror", (error) => {
    errors.push({ type: "pageerror", message: error.message });
    console.error(`[page ERROR] ${error.message}`);
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    const failure = request.failure()?.errorText ?? "unknown error";
    
    // Ignore favicon failures
    if (url.includes("favicon")) return;
    
    // Categorize image failures separately
    if (/\.(png|jpg|jpeg|gif|webp|svg|avif)$/i.test(url)) {
      errors.push({ type: "image", message: failure, url });
      console.error(`[image FAILED] ${url} - ${failure}`);
    } else {
      errors.push({ type: "request", message: failure, url });
      console.error(`[request FAILED] ${url} - ${failure}`);
    }
  });

  return {
    errors,
    warnings,
    getErrorsByType: (type: CollectedError["type"]) =>
      errors.filter((e) => e.type === type),
    printSummary: () => {
      console.log(`\n=== ERROR SUMMARY ===`);
      console.log(`Console errors: ${errors.filter((e) => e.type === "console").length}`);
      console.log(`Page errors: ${errors.filter((e) => e.type === "pageerror").length}`);
      console.log(`Failed requests: ${errors.filter((e) => e.type === "request").length}`);
      console.log(`Failed images: ${errors.filter((e) => e.type === "image").length}`);
      console.log(`Warnings: ${warnings.length}`);
      if (errors.length > 0) {
        console.log(`\nAll errors:\n${errors.map((e) => `  [${e.type}] ${e.message}${e.url ? ` (${e.url})` : ""}`).join("\n")}`);
      }
    }
  };
};

// The brand block is display:none while the sidebar is compact, so it is the
// signal for the expanded state. Nav labels are only clipped, not hidden.
const ensureSidebarExpanded = async (page: import("@playwright/test").Page) => {
  const brand = page.locator(".mep-brand");
  if (await brand.isVisible()) return;
  const toggle = page.locator(".mep-sidebar__toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(brand).toBeVisible();
};

const gotoFixtureApp = async (page: import("@playwright/test").Page) => {
  await page.goto("/?mepFixture=1", { waitUntil: "networkidle" });
  await ensureSidebarExpanded(page);
};

test.describe("Comprehensive error catching", () => {
  test("initial page load - no errors", async ({ page }) => {
    const collector = createErrorCollector(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await ensureSidebarExpanded(page);
    await expect(page.locator(".mep-brand__title")).toHaveText("Enplace");

    collector.printSummary();

    await expect(page.locator(".mep-brand__title")).toHaveText("Enplace");
    expect(collector.errors).toEqual([]);
  });

  test("navigate all views - no errors", async ({ page }) => {
    const collector = createErrorCollector(page);

    // Initial load - Planner view
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator(".mep-main--planner")).toBeVisible();
    await ensureSidebarExpanded(page);

    // Navigate to Recipe Database
    console.log("Navigating to Recipe Database...");
    await page.click('button.mep-nav__item:has-text("Recipe Database")');
    await expect(page.locator(".cooking-db")).toBeVisible();

    // Navigate to Shopping List
    console.log("Navigating to Shopping List...");
    await page.click('button.mep-nav__item:has-text("Shopping List")');
    await expect(page.locator(".shopping-list-view")).toBeVisible();

    // Navigate to Cooking Health
    console.log("Navigating to Cooking Health...");
    await page.click('button.mep-nav__item:has-text("Cooking Health")');
    await expect(page.locator(".cooking-health")).toBeVisible();

    // Navigate to Settings
    console.log("Navigating to Settings...");
    await page.click('button.mep-nav__item:has-text("Settings")');
    await expect(page.locator(".mep-settings")).toBeVisible();

    // Navigate back to Planner
    console.log("Navigating back to Planner...");
    await page.click('button.mep-nav__item:has-text("Planner")');
    await expect(page.locator(".mep-main--planner")).toBeVisible();

    collector.printSummary();
    expect(collector.errors).toEqual([]);
  });

  test("command palette - no errors", async ({ page }) => {
    const collector = createErrorCollector(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator(".mep-main")).toBeVisible();

    // Open command palette
    await page.keyboard.press("Control+k");

    // Command palette should be visible
    await expect(page.locator(".mep-command")).toBeVisible();

    // Type a search
    await page.fill(".mep-command input", "planner");

    // Close palette
    await page.keyboard.press("Escape");
    await expect(page.locator(".mep-command")).toHaveCount(0);

    collector.printSummary();
    expect(collector.errors).toEqual([]);
  });

  test("all UI elements present", async ({ page }) => {
    const collector = createErrorCollector(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await ensureSidebarExpanded(page);

    // Sidebar elements
    await expect(page.locator(".mep-brand__title")).toHaveText("Enplace");
    await expect(page.locator(".mep-brand__subtitle")).toHaveText("Standalone planner");

    // Navigation
    await expect(page.locator('button.mep-nav__item:has-text("Planner")')).toBeVisible();
    await expect(page.locator('button.mep-nav__item:has-text("Recipe Database")')).toBeVisible();
    await expect(page.locator('button.mep-nav__item:has-text("Shopping List")')).toBeVisible();
    await expect(page.locator('button.mep-nav__item:has-text("Cooking Health")')).toBeVisible();
    await expect(page.locator('button.mep-nav__item:has-text("Settings")')).toBeVisible();

    // Footer
    await expect(page.locator(".mep-vault-label")).toHaveText("Vault");
    await expect(page.locator('button:has-text("Choose folder")')).toBeVisible();

    // Main content area
    await expect(page.locator(".mep-main")).toBeVisible();

    // Preview panel is closed by default (opens on Ctrl/Cmd+click)
    await expect(page.locator(".mep-preview")).toHaveCount(0);

    collector.printSummary();
    expect(collector.errors).toEqual([]);
  });

  test("settings page - all inputs work", async ({ page }) => {
    const collector = createErrorCollector(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await page.click('button.mep-nav__item:has-text("Settings")');
    await expect(page.locator(".mep-settings")).toBeVisible();

    // Check settings sections are present
    await expect(page.locator(".mep-settings h2")).toHaveText("Settings");
    await expect(page.locator(".mep-settings h3").first()).toBeVisible();

    // Try interacting with an input
    const recipesInput = page.locator('label:has-text("Recipes folder") input');
    if (await recipesInput.isVisible()) {
      const currentValue = await recipesInput.inputValue();
      await recipesInput.fill("test-folder");
      await expect(recipesInput).toHaveValue("test-folder");
      await recipesInput.fill(currentValue); // Restore
      await expect(recipesInput).toHaveValue(currentValue);
    }

    collector.printSummary();
    expect(collector.errors).toEqual([]);
  });

  test("planner ctrl-click opens latest note in preview pane", async ({ page }) => {
    const collector = createErrorCollector(page);

    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.locator(".mep-main--planner")).toBeVisible();
    await ensureSidebarExpanded(page);

    const cardSelector =
      ".kanban-item:not(.kanban-group-header):not(.kanban-static-item)";
    let count = 0;
    for (const presetId of ["meal", "weekly", "task", "exercise"]) {
      await page.selectOption("#preset-select", presetId);
      await expect(page.locator("#preset-select")).toHaveValue(presetId);
      count = await page.locator(cardSelector).count();
      if (count >= 2) {
        break;
      }
    }
    test.skip(count < 2, "Requires at least two planner cards in the configured vault.");

    const cards = page.locator(cardSelector);

    const firstCard = cards.nth(0);
    const secondCard = cards.nth(1);
    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();

    const firstPath = await firstCard.getAttribute("data-eid");
    const secondPath = await secondCard.getAttribute("data-eid");
    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    const firstFilePath = firstPath?.split("::")[0] ?? "";
    const secondFilePath = secondPath?.split("::")[0] ?? "";

    await firstCard.click({ modifiers: ["Control"] });
    await expect(page.locator(".mep-preview")).toBeVisible();
    await expect(page.locator(".mep-preview")).toHaveAttribute("data-preview-path", firstFilePath);

    await secondCard.click({ modifiers: ["Control"] });
    await expect(page.locator(".mep-preview")).toBeVisible();
    await expect(page.locator(".mep-preview")).toHaveAttribute("data-preview-path", secondFilePath);

    collector.printSummary();
    expect(collector.errors).toEqual([]);
  });

  test("recipe database fixture cards survive search and scroll without image failures", async ({ page }) => {
    const collector = createErrorCollector(page);

    await gotoFixtureApp(page);
    await page.click('button.mep-nav__item:has-text("Recipe Database")');
    await expect(page.locator(".cooking-db__card").first()).toBeVisible();
    await expect(page.locator(".cooking-db__count")).toContainText("recipes");

    const expectedPaths = [
      "recipes/fixture-coq-au-riesling.md",
      "recipes/fixture-lemon-potatoes.md",
      "recipes/fixture-braised-chickpeas.md",
      "recipes/fixture-unscheduled-soup.md"
    ];
    for (const path of expectedPaths) {
      await expect(page.locator(`.cooking-db__card[data-path="${path}"]`)).toHaveCount(1);
    }

    const firstCard = page.locator(".cooking-db__card").first();
    const firstPath = await firstCard.getAttribute("data-path");
    const firstBoxBefore = await firstCard.boundingBox();
    expect(firstPath).toBeTruthy();
    expect(firstBoxBefore?.width ?? 0).toBeGreaterThan(150);
    expect(firstBoxBefore?.height ?? 0).toBeGreaterThan(250);

    const grid = page.locator(".cooking-db__grid-container");
    await grid.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() =>
        grid.evaluate((element) => ({
          atEnd:
            element.scrollHeight <= element.clientHeight ||
            element.scrollTop >= element.scrollHeight - element.clientHeight
        }))
      )
      .toEqual(expect.objectContaining({ atEnd: true }));
    await grid.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.locator(`.cooking-db__card[data-path="${firstPath}"]`)).toBeVisible();
    const firstBoxAfter = await page.locator(`.cooking-db__card[data-path="${firstPath}"]`).boundingBox();
    expect(Math.abs((firstBoxAfter?.height ?? 0) - (firstBoxBefore?.height ?? 0))).toBeLessThan(2);

    await page.fill(".cooking-db__search", "lemon");
    await expect(page.locator('.cooking-db__card[data-path="recipes/fixture-lemon-potatoes.md"]')).toBeVisible();
    await expect(page.locator(".cooking-db__card")).toHaveCount(1);
    await page.fill(".cooking-db__search", "");
    await expect(page.locator(".cooking-db__card")).toHaveCount(expectedPaths.length);

    collector.printSummary();
    expect(collector.getErrorsByType("image")).toEqual([]);
    expect(collector.errors).toEqual([]);
  });

  test("fixture recipe opens from database and does not create flicker duplicates", async ({ page }) => {
    const collector = createErrorCollector(page);

    await gotoFixtureApp(page);
    await page.click('button.mep-nav__item:has-text("Recipe Database")');
    const coqCard = page.locator('.cooking-db__card[data-path="recipes/fixture-coq-au-riesling.md"]');
    await expect(coqCard).toBeVisible();

    const beforeOpenCount = await page.locator(".cooking-db__card").count();
    await coqCard.click();
    await expect(page.locator(".recipe-view--full")).toBeVisible();
    await expect(page.locator(".recipe-view__method-pane")).toContainText("Coq Au Riesling");
    await expect(page.locator(".recipe-view__ingredients-panel")).toBeVisible();

    await page.click('button.mep-nav__item:has-text("Recipe Database")');
    await expect(page.locator(".cooking-db__card")).toHaveCount(beforeOpenCount);
    await expect(page.locator('.cooking-db__card[data-path="recipes/fixture-coq-au-riesling.md"]')).toHaveCount(1);

    collector.printSummary();
    expect(collector.getErrorsByType("image")).toEqual([]);
    expect(collector.errors).toEqual([]);
  });

  test("fixture recipe editor opens and autosaves markdown changes", async ({ page }) => {
    const collector = createErrorCollector(page);

    await gotoFixtureApp(page);
    await page.click('button.mep-nav__item:has-text("Recipe Database")');
    const coqCard = page.locator('.cooking-db__card[data-path="recipes/fixture-coq-au-riesling.md"]');
    await expect(coqCard).toBeVisible();
    await coqCard.click();
    await expect(page.locator(".recipe-view--full")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.locator(".recipe-view__editor")).toBeVisible();
    const contentEditable = page.locator(".mdxeditor-root-contenteditable [contenteditable='true']");
    await expect(contentEditable).toBeVisible();

    await contentEditable.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nEditor smoke save");
    await expect(page.locator(".recipe-view__editor")).toHaveCount(0);
    await expect(page.locator(".recipe-view__mdx")).toContainText("Editor smoke save");
    collector.printSummary();
    expect(collector.errors).toEqual([]);
  });
});
