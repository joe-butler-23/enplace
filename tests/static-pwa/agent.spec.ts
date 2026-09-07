import { expect, test } from "@playwright/test";
import { openCookingSession } from "../../src/agent/session";
import { addShoppingItem, exportedCookbookText, openFreshCookbook, openShopping } from "./helpers";

test("agent recipe images use stored cookbook files without making recipe-controlled requests", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const requested: string[] = [];
  await page.route("**/*enplace-image-probe*", async route => {
    requested.push(route.request().url());
    await route.abort();
  });
  const id = await openFreshCookbook(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await page.getByTitle("Close settings").click();
  const session = await openCookingSession({ id, relayUrl: `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}` });
  const remote = "https://recipe-image-sink.invalid/enplace-image-probe?data=synthetic";
  const local = "/enplace-image-probe?data=synthetic";
  const recipe = (title: string, cover: string, bodyImage: string) =>
    `# ${title}\n\n![Cover](${cover})\n\nSource: ${remote}\n\nMore detail.\n\n![Body](${bodyImage})\n\n<img src="${local}">\n\n---\n\n- *1* onion\n\n---\n\n1. Simmer.\n`;
  try {
    const created = await session.execute("recipe.create", {
      operationId: "browser-image-create", markdown: recipe("Agent remote image", remote, local),
    }) as { path: string; markdown: string };
    await page.getByRole("button", { name: "Open recipe Agent remote image", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agent remote image", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
    await session.execute("recipe.update", {
      operationId: "browser-image-update", path: created.path, base: created.markdown,
      markdown: recipe("Agent same-origin image", local, remote),
    });
    await page.getByRole("button", { name: "Open recipe Agent same-origin image", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agent same-origin image", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Recipe Database", exact: true }).click();
    await session.execute("recipe.create", {
      operationId: "browser-image-stored", markdown: recipe("Agent stored image", "images/banana-oat-loaf.webp", "images/banana-oat-loaf.webp"),
    });
    await page.getByRole("button", { name: "Open recipe Agent stored image", exact: true }).click();
    const hero = page.locator(".recipe-view__hero img");
    await expect(hero).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => hero.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(requested).toEqual([]);
  } finally { await session.close(); await context.close(); }
});

test("agent recipes, meal planning and shopping converge with a partner and survive a fresh session", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await page.getByTitle("Close settings").click();
  const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`;
  const session = await openCookingSession({ id, relayUrl });
  const partner = await browser.newContext();
  const phone = await partner.newPage();
  const call = async (name: string, args: Record<string, unknown> = {}) => await session.execute(name, args) as Record<string, any>;
  const markdown = "# Agent lentils\n\n---\n\n- *200 g* lentils\n- *500 ml* stock\n\n---\n\n1. Simmer until tender.\n";
  try {
    const added = await call("recipe.create", { operationId: "browser-create-lentils", markdown });
    await expect(page.getByRole("button", { name: "Open recipe Agent lentils", exact: true })).toBeVisible();
    const before = await call("recipe.get", { path: added.path });
    await call("recipe.update", { operationId: "browser-amend-lentils", path: added.path,
      base: before.markdown, markdown: before.markdown.replace("Simmer until tender.", "Simmer for 25 minutes.") });
    const plan = await call("plan.read");
    const planned = await call("plan.add", { operationId: "browser-plan-lentils", path: added.path, date: "2026-09-09", expectedRevision: plan.revision });
    const shopping = await call("shopping.read");
    await call("shopping.build", { operationId: "browser-build-shopping", week: "2026-09-07", expectedRevision: shopping.revision, planRevision: planned.revision });
    await phone.goto(`/shopping#k=${id}`);
    await expect(phone.getByRole("heading", { name: "Shopping list" })).toBeVisible();
    await addShoppingItem(phone, "Partner lemons");
    await expect.poll(async () => (await call("shopping.read")).items.some((item: any) => item.content === "Partner lemons")).toBe(true);
    const current = await call("shopping.read");
    const lentils = current.items.filter((item: any) => /lentils/.test(item.content));
    expect(lentils).toHaveLength(1);
    await call("shopping.check", { operationId: "browser-check-lentils", itemIds: lentils.map((item: any) => item.id), expectedRevision: current.revision });
    await expect(phone.getByRole("checkbox", { name: /200 g lentils/ })).toBeChecked();
    await expect(phone.getByRole("checkbox", { name: "Partner lemons", exact: true })).not.toBeChecked();
    await session.close();
    await phone.reload();
    await expect(phone.getByRole("checkbox", { name: /200 g lentils/ })).toBeChecked();
    await expect(phone.getByRole("checkbox", { name: "Partner lemons", exact: true })).toBeVisible();
    expect(await exportedCookbookText(page, added.path)).toContain("Simmer for 25 minutes.");
    expect(await exportedCookbookText(page, "Plan.md")).toContain("2026-09-09");
    const fresh = await openCookingSession({ id, relayUrl });
    try {
      const replay = await fresh.execute("recipe.create", { operationId: "browser-create-lentils", markdown }) as any;
      expect(replay.replayed).toBe(true);
      const state = await fresh.execute("shopping.read", {}) as any;
      expect(state.items.find((item: any) => /lentils/.test(item.content)).checked).toBe(true);
      expect(state.items.some((item: any) => item.content === "Partner lemons")).toBe(true);
    } finally { await fresh.close(); }
    await openShopping(page);
    await expect(page.getByRole("checkbox", { name: "Partner lemons", exact: true })).toBeVisible();
  } finally { await session.close(); await partner.close(); }
});
