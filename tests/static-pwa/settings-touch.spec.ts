import { expect, test } from "@playwright/test";
import { newAppContext } from "./helpers";

test("Settings stays open after a trusted touch tap", async ({ browser, browserName }) => {
  test.skip(browserName === "firefox", "Firefox has no mobile emulation; the trailing-click defect is a touch-event path Chromium and WebKit exercise");
  const context = await newAppContext(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await settings.tap();
    await expect(page).toHaveURL(/\/settings(?:#|$)/);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  } finally {
    await context.close();
  }
});
