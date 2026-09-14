const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const OUT = process.argv[2];
const LIVE = process.argv[3] ?? 'https://enplace-trial.pages.dev/';
if (!OUT) throw new Error('Usage: node scripts/record-demo.cjs <output-directory> [preview-url]');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function addDemoLayer(context) {
  await context.addInitScript(() => {
    localStorage.setItem('enplace.preferences', JSON.stringify({ helpAcknowledged: true, acknowledgedCookbookIds: location.hash ? [location.hash.slice(3)] : [] }));
    const install = () => {
      if (document.getElementById('enplace-demo-cursor')) return;
      const style = document.createElement('style');
      style.textContent = `
        #enplace-demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 28px;
          z-index: 2147483647; pointer-events: none; opacity: 0; transform: translate(-2px,-2px);
          background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='28' viewBox='0 0 22 28'%3E%3Cpath d='M2 2v20l5-5 4 9 4-2-4-9h8z' fill='white' stroke='%231d2822' stroke-width='2' stroke-linejoin='round'/%3E%3C/svg%3E");
          filter: drop-shadow(0 1px 1px rgba(0,0,0,.28)); }
        #enplace-demo-caption { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
          z-index: 2147483646; max-width: 80vw; padding: 10px 16px; border-radius: 9px;
          background: rgba(24,34,28,.94); color: white; box-shadow: 0 4px 18px rgba(0,0,0,.18);
          font: 600 18px/1.2 ui-sans-serif,system-ui,sans-serif; letter-spacing: -.01em;
          pointer-events: none; white-space: nowrap; }
        #enplace-demo-caption:empty { display:none; }
      `;
      const cursor = document.createElement('div'); cursor.id = 'enplace-demo-cursor';
      const caption = document.createElement('div'); caption.id = 'enplace-demo-caption';
      document.documentElement.append(style, cursor, caption);
      document.addEventListener('pointermove', event => {
        cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; cursor.style.opacity = '1';
      }, true);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
    else install();
  });
}

async function caption(page, text) {
  await page.evaluate(value => { const el = document.getElementById('enplace-demo-caption'); if (el) el.textContent = value; }, text);
}

async function moveTo(page, locator, steps = 28) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No box for ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}

async function humanClick(page, locator, pauseAfter = 850) {
  await moveTo(page, locator);
  await sleep(180);
  await page.mouse.down(); await sleep(120); await page.mouse.up();
  await sleep(pauseAfter);
}

async function humanDrag(page, source, target) {
  await source.scrollIntoViewIfNeeded(); await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error('Missing drag geometry');
  const sx = from.x + from.width * .50, sy = from.y + Math.min(from.height * .42, 100);
  const tx = to.x + to.width * .50, ty = to.y + Math.min(to.height * .42, 180);
  await page.mouse.move(sx, sy, { steps: 30 }); await sleep(300);
  await page.mouse.down(); await sleep(350);
  await page.mouse.move(sx + 8, sy + 6, { steps: 4 });
  await page.mouse.move(tx, ty, { steps: 50 }); await sleep(500);
  await page.mouse.up(); await sleep(1300);
}

function watch(page, label, observations) {
  page.on('console', message => {
    if (message.type() === 'error') observations.push(`${label} console error: ${message.text()}`);
  });
  page.on('pageerror', error => observations.push(`${label} page error: ${error.message}`));
  page.on('requestfailed', request => observations.push(`${label} request failed: ${request.url()} — ${request.failure()?.errorText}`));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const observations = [];
  const timeline = {};
  const browser = await chromium.launch({ headless: true });

  // Main 1440x900 story: database -> marked queue -> scheduled days -> shopping list.
  const mainContext = await browser.newContext({
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  await addDemoLayer(mainContext);
  const mainPage = await mainContext.newPage();
  const mainVideo = mainPage.video();
  watch(mainPage, 'main', observations);
  await mainPage.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await mainPage.getByText('11 recipes', { exact: true }).waitFor({ timeout: 30000 });
  // Wait for thumbnails before any edit. Reloading here would abort the non-blocking cover seed.
  const firstCard = mainPage.locator('.cooking-db__card[data-has-cover="true"]').first();
  await firstCard.locator('.cooking-db__cover img').waitFor({ timeout: 30000 });
  // Acknowledge the synthetic cookbook through the app, then undo that setup edit before the trim.
  await firstCard.getByRole('checkbox', { name: 'Add to planner' }).check();
  const backup = mainPage.waitForEvent('download');
  await mainPage.getByRole('button', { name: 'Download backup' }).click();
  await backup;
  await mainPage.getByRole('button', { name: 'Download backup' }).waitFor({ state: 'detached' });
  await firstCard.getByRole('checkbox', { name: 'In planner' }).uncheck();
  await firstCard.getByRole('checkbox', { name: 'Add to planner' }).waitFor({ state: 'attached' });
  const mainCreated = Date.now();
  await sleep(1800);
  await caption(mainPage, 'Add recipes to the planner');
  await mainPage.mouse.move(1340, 820, { steps: 2 });
  timeline.mainStart = (Date.now() - mainCreated) / 1000;
  timeline.sharedUrl = mainPage.url();
  await sleep(4300);

  await caption(mainPage, 'Add recipes to the planner');
  const cards = mainPage.locator('.cooking-db__card');
  const chosenTitles = [];
  for (const index of [0, 1, 2]) {
    const card = cards.nth(index);
    chosenTitles.push((await card.locator('.cooking-db__title').innerText()).trim());
    await humanClick(mainPage, card.locator('.cooking-db__toggle'), 1000);
    await card.getByRole('checkbox', { name: 'In planner' }).waitFor({ state: 'attached' });
  }
  timeline.chosenTitles = chosenTitles;
  await sleep(1400);

  await humanClick(mainPage, mainPage.getByRole('button', { name: 'Planner', exact: true }), 600);
  const markedLane = mainPage.locator('.kanban-board[data-id="marked"]');
  await markedLane.locator('.card-cover img').first().waitFor({ timeout: 15000 });
  await caption(mainPage, 'Drag them onto days');
  await sleep(4200);

  await caption(mainPage, 'Drag them onto days');
  for (const targetIndex of [1, 2, 3]) {
    const source = markedLane.locator('.organiser-card--recipe-card').first().locator('.card-cover');
    const target = mainPage.locator('.kanban-board').nth(targetIndex);
    await humanDrag(mainPage, source, target);
    await target.locator('.organiser-card--recipe-card').first().waitFor();
  }
  await sleep(1800);

  await caption(mainPage, 'Your shopping list builds itself');
  await humanClick(mainPage, mainPage.getByRole('button', { name: 'Shopping List', exact: true }), 800);
  await mainPage.getByRole('heading', { name: 'Shopping list' }).waitFor({ timeout: 15000 });
  await mainPage.getByRole('checkbox').first().waitFor();
  await sleep(5200);
  timeline.mainEnd = (Date.now() - mainCreated) / 1000;
  timeline.sharedUrl = mainPage.url();
  timeline.shoppingCount = await mainPage.getByRole('checkbox').count();
  await mainPage.screenshot({ path: path.join(OUT, 'observed-main-final.png') });
  await mainContext.close();
  await mainVideo.saveAs(path.join(OUT, 'raw-main.webm'));

  // Shared-device beat: two independent browser contexts on the same private throwaway link.
  const makePhone = async label => {
    const context = await browser.newContext({
      viewport: { width: 720, height: 900 }, deviceScaleFactor: 1,
      recordVideo: { dir: OUT, size: { width: 720, height: 900 } },
    });
    await addDemoLayer(context);
    const page = await context.newPage();
    const created = Date.now();
    watch(page, label, observations);
    return { context, page, created, video: page.video() };
  };
  const left = await makePhone('left device');
  const right = await makePhone('right device');
  await Promise.all([
    left.page.goto(timeline.sharedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    right.page.goto(timeline.sharedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
  ]);
  await Promise.all([
    left.page.getByRole('heading', { name: 'Shopping list' }).waitFor({ timeout: 30000 }),
    right.page.getByRole('heading', { name: 'Shopping list' }).waitFor({ timeout: 30000 }),
  ]);
  await Promise.all([
    left.page.waitForFunction(expected => document.querySelectorAll('input[type="checkbox"]').length === expected, timeline.shoppingCount, { timeout: 30000 }),
    right.page.waitForFunction(expected => document.querySelectorAll('input[type="checkbox"]').length === expected, timeline.shoppingCount, { timeout: 30000 }),
  ]);
  await caption(left.page, 'My list'); await caption(right.page, "Partner's list");
  await left.page.mouse.move(650, 820, { steps: 2 });
  await right.page.mouse.move(650, 820, { steps: 2 });
  await sleep(2000);
  timeline.leftStart = (Date.now() - left.created) / 1000;
  timeline.rightStart = (Date.now() - right.created) / 1000;
  await sleep(2600);
  await caption(left.page, 'One tick. Every shared device.');
  await caption(right.page, 'One tick. Every shared device.');
  const firstLeft = left.page.getByRole('checkbox').first();
  const itemName = (await firstLeft.locator('xpath=..').locator('.shopping-item__name > span').innerText()).trim();
  const firstRight = right.page.getByRole('checkbox', { name: itemName, exact: true }).first();
  await moveTo(left.page, firstLeft.locator('xpath=..'), 35);
  await sleep(450); await left.page.mouse.down(); await sleep(160); await left.page.mouse.up();
  await firstRight.waitFor();
  await right.page.waitForFunction(name => Array.from(document.querySelectorAll('.shopping-item')).some(row =>
    row.textContent?.includes(name) && row.querySelector('input[type="checkbox"]')?.checked
  ), itemName, { timeout: 5000 });
  timeline.syncedItem = itemName;
  timeline.syncObservedAt = new Date().toISOString();
  await sleep(4950);
  timeline.leftEnd = (Date.now() - left.created) / 1000;
  timeline.rightEnd = (Date.now() - right.created) / 1000;
  await Promise.all([
    left.page.screenshot({ path: path.join(OUT, 'observed-left-synced.png') }),
    right.page.screenshot({ path: path.join(OUT, 'observed-right-synced.png') }),
  ]);
  await left.context.close(); await right.context.close();
  await left.video.saveAs(path.join(OUT, 'raw-left.webm'));
  await right.video.saveAs(path.join(OUT, 'raw-right.webm'));
  await browser.close();

  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2));
  fs.writeFileSync(path.join(OUT, 'browser-observations.log'), observations.length ? observations.join('\n') + '\n' : 'No console errors, page errors, or failed requests observed.\n');
  console.log(JSON.stringify(timeline, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
