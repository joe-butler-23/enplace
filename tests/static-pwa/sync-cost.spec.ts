import { expect, test } from "@playwright/test";
import { addShoppingItem, openFreshCookbook, openShopping } from "./helpers";

/**
 * Sync cost is measured in bytes, which are deterministic, not in milliseconds. Before the wire
 * document became the persisted copy, a reopen re-sent the whole cookbook (878 KB seeded) and
 * every 64th tick did the same; the partner then downloaded each copy before later ticks applied.
 */
test("a reopen exchanges only what the relay lacks and a hundred ticks never re-send the cookbook", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const id = await openFreshCookbook(page);
  await openShopping(page);
  await addShoppingItem(page, "measure item");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Connected. Changes sync through the relay.", { exact: true })).toBeVisible();
  await page.getByTitle("Close settings").click();

  const context = await browser.newContext();
  const partner = await context.newPage();
  let joinReceived = 0;
  partner.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => { joinReceived += Buffer.from(payload).length; });
  });
  await partner.goto(`/shopping#k=${id}`);
  await expect(partner.getByRole("checkbox", { name: "measure item" })).toBeVisible();
  expect(joinReceived).toBeLessThan(1_000_000);

  // The partner keeps the room alive on the test relay, which evicts empty rooms.
  let sent = 0;
  let received = 0;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => { sent += Buffer.from(payload).length; });
    socket.on("framereceived", ({ payload }) => { received += Buffer.from(payload).length; });
  });
  await page.reload();
  await expect(page.locator(".mep-shell")).toBeVisible();
  const closeSettings = page.getByTitle("Close settings");
  if (await closeSettings.isVisible()) await closeSettings.click();
  if (!(await page.getByRole("heading", { name: "Shopping list" }).isVisible())) await openShopping(page);
  await expect(page.getByRole("checkbox", { name: "measure item" })).toBeVisible();
  await expect.poll(() => sent).toBeGreaterThan(0);
  expect(sent).toBeLessThan(5_000);
  expect(received).toBeLessThan(5_000);

  const beforeTicks = sent;
  for (let n = 0; n < 100; n++) {
    const [from, to] = n % 2 ? [partner, page] : [page, partner];
    const box = to.getByRole("checkbox", { name: "measure item" });
    const before = await box.isChecked();
    await from.getByText("measure item", { exact: true }).click();
    await expect(box).toBeChecked({ checked: !before });
  }
  expect(sent - beforeTicks).toBeLessThan(100_000);
  await context.close();
});
