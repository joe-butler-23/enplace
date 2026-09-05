import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

const recipeSuffix = "\n\n## Ingredients\n- onion\n\n## Method\n1. Simmer.\n";

const recipeFile = {
  name: "merge-soup.md",
  mimeType: "text/markdown",
  buffer: Buffer.from(`---\ntitle: Merge Soup\n---\n\n# Merge Soup\n\nFirst base paragraph.\n\nSecond base paragraph.${recipeSuffix}`),
};

const relayReadyFile = {
  name: "relay-ready.md",
  mimeType: "text/markdown",
  buffer: Buffer.from("---\ntitle: Relay Ready\n---\n\n# Relay Ready\n\n## Ingredients\n- water\n\n## Method\n1. Wait.\n"),
};

async function createCookbookWithRecipe(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/#k=e1_[a-z2-7]{52}$/);
  await expect(page.getByText("11 recipes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  const input = page.locator(".mep-settings__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles(recipeFile);
  await expect(page.locator(".mep-notices")).toContainText("Imported 1 file; skipped 0 existing files.");
  await page.getByTitle("Close settings").click();
  await expect(page.getByText("Merge Soup", { exact: true })).toBeVisible();
}

async function joinCookbook(browser: Browser, url: string, owner: Page): Promise<{ context: BrowserContext; page: Page }> {
  await owner.getByRole("button", { name: "Settings", exact: true }).dispatchEvent("click");
  await expect(owner.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await owner.getByTitle("Close settings").click();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByText("Merge Soup", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).dispatchEvent("click");
  const input = page.locator(".mep-settings__file-button", { hasText: "Import files" }).locator('input[type="file"]');
  await input.setInputFiles(relayReadyFile);
  await expect(page.locator(".mep-notices")).toContainText("Imported 1 file; skipped 0 existing files.");
  await page.getByTitle("Close settings").click();
  await expect(owner.getByRole("button", { name: "Open recipe Relay Ready" })).toBeVisible();
  return { context, page };
}

async function openEditor(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Open recipe Merge Soup" }).dispatchEvent("click");
  await expect(page.getByRole("heading", { name: "Merge Soup" })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).dispatchEvent("click");
  const editor = page.getByRole("textbox", { name: /Recipe markdown/ });
  await expect(editor).toBeVisible();
  return editor;
}

async function replaceParagraph(_page: Page, editor: Locator, from: string, to: string | null): Promise<void> {
  const current = await editor.inputValue();
  expect(current).toContain(from);
  await editor.fill(current.replace(from, to ?? ""));
}

async function editTogether(
  leftPage: Page, left: Locator, leftFrom: string, leftTo: string | null,
  rightPage: Page, right: Locator, rightFrom: string, rightTo: string | null,
): Promise<void> {
  await Promise.all([
    replaceParagraph(leftPage, left, leftFrom, leftTo),
    replaceParagraph(rightPage, right, rightFrom, rightTo),
  ]);
  await Promise.all([
    expect(leftPage.locator('[data-save-state="dirty"]')).toBeVisible(),
    expect(rightPage.locator('[data-save-state="dirty"]')).toBeVisible(),
  ]);
  if (leftTo !== null) await expect.poll(() => editorText(left)).toContain(leftTo);
  if (rightTo !== null) await expect.poll(() => editorText(right)).toContain(rightTo);
  else await expect.poll(() => editorText(right)).not.toContain(rightFrom);
  await rightPage.getByRole("button", { name: "Recipe Database" }).dispatchEvent("click");
  await expect(rightPage.getByRole("heading", { name: "Recipe Database" })).toBeVisible();
  await expect(leftPage.locator('[data-save-state="saved"]')).toBeVisible();
}

async function editorText(editor: Locator): Promise<string> {
  return editor.evaluate((node) => node instanceof HTMLTextAreaElement ? node.value : node.textContent ?? "");
}

async function expectBothEditors(left: Locator, right: Locator, values: string[]): Promise<void> {
  for (const value of values) {
    await expect.poll(() => editorText(left)).toContain(value);
    await expect.poll(() => editorText(right)).toContain(value);
  }
}

test("two devices keep disjoint recipe paragraphs", async ({ page, browser }) => {
  await createCookbookWithRecipe(page);
  const peer = await joinCookbook(browser, page.url(), page);
  try {
    const [aliceDraft, bobDraft] = await Promise.all([openEditor(page), openEditor(peer.page)]);
    await editTogether(
      page, aliceDraft, "First base paragraph.", "First paragraph from Alice.",
      peer.page, bobDraft, "Second base paragraph.", "Second paragraph from Bob.",
    );
    const alice = aliceDraft;
    const bob = await openEditor(peer.page);
    await expectBothEditors(alice, bob, ["First paragraph from Alice.", "Second paragraph from Bob."]);
    await expect(page.locator('[data-merge-conflict="true"]')).toHaveCount(0);
    await expect(peer.page.locator('[data-merge-conflict="true"]')).toHaveCount(0);
  } finally {
    await peer.context.close();
  }
});

test("two devices show both overlapping recipe versions", async ({ page, browser }) => {
  await createCookbookWithRecipe(page);
  const peer = await joinCookbook(browser, page.url(), page);
  try {
    const [aliceDraft, bobDraft] = await Promise.all([openEditor(page), openEditor(peer.page)]);
    await editTogether(
      page, aliceDraft, "First base paragraph.", "First paragraph from Alice.",
      peer.page, bobDraft, "First base paragraph.", "First paragraph from Bob.",
    );
    const alice = aliceDraft;
    const bob = await openEditor(peer.page);
    await expectBothEditors(alice, bob, [
      "<<<<<<< this device", "First paragraph from Alice.", "=======", "First paragraph from Bob.", ">>>>>>>>",
    ]);
    await expect(page.locator('[data-merge-conflict="true"]')).toHaveText(
      "Both versions kept where edits overlapped; look for the marked lines.",
    );
  } finally {
    await peer.context.close();
  }
});

test("two devices keep a recipe paragraph edit beside its deletion", async ({ page, browser }) => {
  await createCookbookWithRecipe(page);
  const peer = await joinCookbook(browser, page.url(), page);
  try {
    const [aliceDraft, bobDraft] = await Promise.all([openEditor(page), openEditor(peer.page)]);
    await editTogether(
      page, aliceDraft, "First base paragraph.", "First paragraph edited by Alice.",
      peer.page, bobDraft, "First base paragraph.", null,
    );
    const alice = aliceDraft;
    const bob = await openEditor(peer.page);
    await expectBothEditors(alice, bob, [
      "<<<<<<< this device", "First paragraph edited by Alice.", "=======", ">>>>>>>>", "Second base paragraph.",
    ]);
  } finally {
    await peer.context.close();
  }
});


test("deletes a recipe and returns to the database", async ({ page }) => {
  await createCookbookWithRecipe(page);
  await page.getByRole("button", { name: "Open recipe Merge Soup" }).dispatchEvent("click");
  await expect(page.getByRole("heading", { name: "Merge Soup" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete recipe" }).click();
  await expect(page.getByRole("heading", { name: "Recipe Database" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open recipe Merge Soup" })).toHaveCount(0);
});


test("a recipe deleted on one device while edited on another keeps the edited recipe", async ({ page, browser, browserName }) => {
  test.skip(browserName === "webkit", "Playwright WebKit cannot reload while offline (internal error); Safari offline behaviour is verified on a device");
  await createCookbookWithRecipe(page);
  const peer = await joinCookbook(browser, page.url(), page);
  try {
    await page.context().setOffline(true);
    await peer.context.setOffline(true);
    // Offline mode does not sever an already-open socket on every engine; a reload reconnects under it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await peer.page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Open recipe Merge Soup" }).dispatchEvent("click");
    const editor = await openEditor(peer.page);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete recipe" }).click();
    await expect(page.getByRole("button", { name: "Open recipe Merge Soup" })).toHaveCount(0);
    await replaceParagraph(peer.page, editor, "First base paragraph.", "First paragraph edited while offline.");
    await expect(peer.page.locator('[data-save-state="saved"]')).toBeVisible();

    await peer.context.setOffline(false);
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "Open recipe Merge Soup" })).toBeVisible();
    await page.getByRole("button", { name: "Open recipe Merge Soup" }).dispatchEvent("click");
    await expect(page.getByText("First paragraph edited while offline.", { exact: true })).toBeVisible();
    await expect(page.getByText("Second base paragraph.", { exact: true })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
    await peer.context.setOffline(false);
    await peer.context.close();
  }
});
