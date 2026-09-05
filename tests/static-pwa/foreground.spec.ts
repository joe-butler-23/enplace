import { expect, test } from "@playwright/test";
import { addShoppingItem, openFreshCookbook, openShopping } from "./helpers";

test("returning to the foreground replaces a dead connection instead of waiting out the silence timeout", async ({ page, browser }) => {
  const id = await openFreshCookbook(page);
  await openShopping(page);
  await addShoppingItem(page, "foreground proof");

  const context = await browser.newContext();
  const partner = await context.newPage();
  // Each socket gets its own valve. A closed valve is a half-open connection: frames vanish
  // in both directions and no close event ever arrives.
  const valves: Array<{ open: boolean }> = [];
  await context.routeWebSocket(/.*/, (socket) => {
    const valve = { open: true };
    valves.push(valve);
    const server = socket.connectToServer();
    socket.onMessage((message) => { if (valve.open) server.send(message); });
    server.onMessage((message) => { if (valve.open) socket.send(message); });
  });
  try {
    await partner.goto(`/shopping#k=${id}`);
    const item = partner.getByRole("checkbox", { name: "foreground proof" });
    await expect(item).toBeVisible();
    expect(valves).toHaveLength(1);
    valves[0].open = false;

    await page.getByText("foreground proof", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "foreground proof" })).toBeChecked();
    await partner.waitForTimeout(500);
    await expect(item).not.toBeChecked();

    await partner.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(item).toBeChecked({ timeout: 5_000 });
    expect(valves).toHaveLength(2);
  } finally {
    await context.close();
  }
});
