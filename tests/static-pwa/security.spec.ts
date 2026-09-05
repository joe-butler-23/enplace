import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { addShoppingItem, openFreshCookbook, openShopping } from "./helpers";

test("browser sharing sends only ciphertext and a derived room id", async ({ page, browser }) => {
  const frames: Buffer[] = [];
  const addresses: string[] = [];
  page.on("websocket", (socket) => {
    addresses.push(socket.url());
    socket.on("framesent", ({ payload }) => frames.push(Buffer.from(payload)));
  });
  const id = await openFreshCookbook(page);
  await openShopping(page);
  const item = "Confidential persimmons 983712";
  await addShoppingItem(page, item);
  const context = await browser.newContext();
  const partner = await context.newPage();
  try {
    await partner.goto(`/shopping#k=${id}`);
    await expect(partner.getByRole("checkbox", { name: item })).toBeVisible();
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((url) => /\/e1-[a-f0-9]{64}$/.test(url))).toBe(true);
    expect(addresses.join()).not.toContain(id);
    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.concat(frames).toString()).not.toMatch(/Confidential persimmons|Shopping\.md|text:Shopping/);
    await partner.getByText(item, { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: item })).toBeChecked();
  } finally { await context.close(); }
});

test("the built CSP blocks unrelated connections and rendered Markdown stays inert", async ({ page }) => {
  const headers = await readFile("dist-static/_headers", "utf8");
  const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1];
  expect(csp).toBeTruthy();
  expect(csp).not.toContain(" wss:;");
  // Vite preview does not implement Pages _headers. Apply the exact built policy
  // to the document; the separate Pages gate proves the real serving boundary.
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp! } });
  });
  await openFreshCookbook(page);
  const violation = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("CSP did not report the blocked connection")), 3000);
    document.addEventListener("securitypolicyviolation", (event) => {
      clearTimeout(deadline);
      resolve(event.violatedDirective);
    }, { once: true });
    void fetch("https://unrelated.invalid/collect").catch(() => {});
  }));
  expect(violation).toBe("connect-src");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".mep-settings__file-button", { hasText: "Import files" }).locator("input").setInputFiles({
    name: "hostile.md", mimeType: "text/markdown", buffer: Buffer.from(`# Hostile recipe
\n---\n- one onion\n---\n
<script>window.__recipeExecuted=true</script>
<img src=x onerror="window.__recipeExecuted=true">
<svg><a xlink:href="javascript:alert(1)">bad</a></svg>

[bad scheme](javascript:alert(1))
[encoded scheme](jav&#x61;script:alert(1))
[data scheme](data:text/html,attack)
[protocol relative](//example.com/unwanted)
[good link](https://example.com/recipe)
`),
  });
  await expect(page.locator(".mep-notices")).toContainText("1 recipe recognised");
  await page.getByTitle("Close settings").click();
  await page.getByRole("button", { name: "Open recipe Hostile recipe" }).click();
  const rendered = page.locator(".recipe-view__read-document");
  await expect(rendered).toBeVisible();
  await expect(rendered.locator("script,svg,iframe,[onerror],[onclick]")).toHaveCount(0);
  await expect(rendered.getByRole("link", { name: /bad scheme|encoded scheme|data scheme|protocol relative/ })).toHaveCount(0);
  await expect(rendered.getByRole("link", { name: "good link" })).toHaveAttribute("href", "https://example.com/recipe");
  expect(await page.evaluate(() => (window as Window & { __recipeExecuted?: boolean }).__recipeExecuted)).toBeUndefined();
});
