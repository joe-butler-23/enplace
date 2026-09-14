import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const origin = process.argv[2] ?? "http://127.0.0.1:4187";
const output = new URL("../public/help/", import.meta.url);
const directory = output.pathname;
const scratch = await mkdtemp(join(tmpdir(), "enplace-help-"));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 480, height: 540 }, deviceScaleFactor: 1 });
await context.addInitScript(() => localStorage.setItem("enplace.preferences", JSON.stringify({ helpAcknowledged: true })));
const page = await context.newPage();

async function capture(name) {
  const png = join(scratch, `${name}.png`);
  await page.screenshot({ path: png });
  execFileSync("ffmpeg", ["-y", "-i", png, "-c:v", "libwebp", "-quality", "56", join(directory, `${name}.webp`)], { stdio: "inherit" });
}

try {
  await mkdir(directory, { recursive: true });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByText("11 recipes", { exact: true }).waitFor();
  const card = page.locator(".cooking-db__card").first();
  await card.getByRole("checkbox", { name: "Add to planner" }).check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  await download;
  await page.getByRole("button", { name: "Download backup" }).waitFor({ state: "detached" });
  await card.scrollIntoViewIfNeeded();
  await capture("add-to-planner");

  await page.getByRole("button", { name: "Planner" }).click();
  const queue = page.locator('.kanban-board[data-id="marked"]');
  const day = page.locator('.kanban-board').nth(1);
  const plannerCard = queue.getByRole("button", { name: /Open / }).first();
  await plannerCard.focus();
  await plannerCard.press("ArrowRight");
  await day.locator(".organiser-card--recipe-card").first().waitFor();
  await capture("drag-onto-days");

  await page.getByRole("button", { name: "Shopping List" }).click();
  await page.getByRole("heading", { name: "Shopping list" }).waitFor();
  await page.getByRole("checkbox").first().waitFor();
  await capture("shopping-list");
} finally {
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
}
