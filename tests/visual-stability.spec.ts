import { expect, test, type Page } from "@playwright/test";

type CardSnapshot = {
  path: string;
  index: number;
  top: number;
  left: number;
};

type BoardSnapshot = {
  id: string;
  itemIds: string[];
};

const fixtureUrl = "/?mepFixture=visual";

type DatabaseFirstPaint = { invalid: number; errors: number; ready: number; publications: number };

async function waitForDatabaseReady(page: Page): Promise<DatabaseFirstPaint> {
  await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
  await expect.poll(
    async () => page.evaluate(() => (globalThis as { __MEP_SHIM_FIXTURE_ID__?: string }).__MEP_SHIM_FIXTURE_ID__),
    { timeout: 5000, message: "Expected a fresh visual-fixture build (visual-v1 identity)." }
  ).toBe("visual-v1");
  const sidebarToggle = page.locator(".mep-sidebar__toggle");
  const captureButton = page.locator('button:has-text("Capture recipe")');
  if (!(await captureButton.isVisible()) && (await sidebarToggle.isVisible())) {
    await sidebarToggle.click();
  }
  await page.evaluate(() => {
    const target = document.body;
    const tracker = {
      firstPublicationInvalid: 0,
      firstPublicationErrors: 0,
      firstPublicationReady: 0,
      publications: 0,
      observer: null as MutationObserver | null
    };
    const sample = () => {
      const cards = Array.from(document.querySelectorAll(".cooking-db__card"));
      if (cards.length === 0) return;
      const states = cards.map((card) => (card as HTMLElement).dataset.imageState);
      const invalid = states.filter((state) => state !== "ready" && state !== "none" && state !== "error").length;
      const errors = states.filter((state) => state === "error").length;
      tracker.publications += 1;
      if (tracker.publications === 1) {
        tracker.firstPublicationInvalid = invalid;
        tracker.firstPublicationErrors = errors;
        tracker.firstPublicationReady = states.filter((state) => state === "ready").length;
      }
    };
    tracker.observer = new MutationObserver(sample);
    tracker.observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-image-state"] });
    (window as Window & { __mepDatabaseFirstPaint?: typeof tracker }).__mepDatabaseFirstPaint = tracker;
  });
  await page.locator('button.mep-nav__item:has-text("Recipe Database")').click();
  await expect(page.locator(".cooking-db__count")).toContainText("recipes");
  await expect.poll(async () => page.locator(".cooking-db__card").count()).toBeGreaterThan(0);
  const firstPaint = await page.evaluate(() => {
    const tracker = (window as Window & { __mepDatabaseFirstPaint?: { observer?: MutationObserver; firstPublicationInvalid: number; firstPublicationErrors: number; firstPublicationReady: number; publications: number } }).__mepDatabaseFirstPaint;
    tracker?.observer?.disconnect();
    return {
      invalid: tracker?.firstPublicationInvalid ?? -1,
      errors: tracker?.firstPublicationErrors ?? -1,
      ready: tracker?.firstPublicationReady ?? 0,
      publications: tracker?.publications ?? 0
    };
  });
  expect(firstPaint.publications).toBeGreaterThan(0);
  expect(firstPaint.invalid).toBe(0);
  expect(firstPaint.errors).toBe(0);
  expect(firstPaint.ready).toBeGreaterThan(0);
  await page.waitForFunction(() => {
    const grid = document.querySelector(".cooking-db__grid-container");
    return Boolean(grid && grid.clientHeight > 0 && grid.scrollHeight > grid.clientHeight);
  });
  return firstPaint;
}

async function stableRecipeView(page: Page): Promise<{
  layoutShifts: number;
  aboveFoldImages: number;
  syntheticImages: number;
  incompleteImages: number;
}> {
  return page.evaluate(async () => {
    const view = document.querySelector(".recipe-view--full");
    if (!view) throw new Error("Recipe view is not visible.");
    const viewportHeight = window.innerHeight;
    const images = Array.from(view.querySelectorAll("img")).filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < viewportHeight;
    });
    const waitForTerminalImageState = (image: HTMLImageElement): Promise<void> => {
      if (image.complete) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let timer = 0;
        const finish = () => {
          window.clearTimeout(timer);
          image.removeEventListener("load", finish);
          image.removeEventListener("error", finish);
          resolve();
        };
        timer = window.setTimeout(() => {
          image.removeEventListener("load", finish);
          image.removeEventListener("error", finish);
          reject(new Error(`Timed out waiting for above-fold recipe image: ${image.src}`));
        }, 5000);
        image.addEventListener("load", finish, { once: true });
        image.addEventListener("error", finish, { once: true });
      });
    };
    await Promise.all(images.map(waitForTerminalImageState));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const syntheticImages = images.filter((image) => image.naturalWidth <= 1 || image.naturalHeight <= 1).length;
    const evidenceImages = images.filter((image) => image.naturalWidth > 1 && image.naturalHeight > 1);
    const incompleteImages = evidenceImages.filter((image) => !image.complete || image.naturalWidth === 0).length;
    const layoutShifts = Number((window as Window & { __mepLayoutShifts?: number }).__mepLayoutShifts ?? 0);
    return { layoutShifts, aboveFoldImages: images.length, syntheticImages, incompleteImages };
  });
}

function getVisibleCards(page: Page): Promise<CardSnapshot[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".cooking-db__card")).map((card, index) => {
    const element = card as HTMLElement;
    const rect = element.getBoundingClientRect();
    return {
      path: element.dataset.path ?? "",
      index,
      top: rect.top,
      left: rect.left,
    };
  }));
}

async function measureDatabaseScroll(page: Page): Promise<{
  p95FrameGapMs: number;
  blankFrames: number;
  errorFrames: number;
  maxErrorCards: number;
  minReadyCards: number;
  maxNoCoverCards: number;
  errorPaths: string[];
  maxInvalidCards: number;
}> {
  return page.evaluate(async () => {
    const root = document.querySelector(".cooking-db__grid-container");
    if (!root) throw new Error("Missing recipe grid container.");
    const scrollElement = [root, ...Array.from(root.querySelectorAll("*"))].find((element) => {
      const style = window.getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 40 && style.overflowY !== "visible" && style.overflowY !== "hidden";
    }) as HTMLElement | undefined;
    if (!scrollElement) throw new Error("Missing scrollable recipe grid element.");
    const viewport = () => scrollElement.getBoundingClientRect();
    const gaps: number[] = [];
    let last = performance.now();
    let maxInvalidCards = 0;
    let blankFrames = 0;
    let errorFrames = 0;
    let maxErrorCards = 0;
    let minReadyCards = Number.POSITIVE_INFINITY;
    let maxNoCoverCards = 0;
    const errorPaths = new Set<string>();
    const sample = (now: number) => {
      gaps.push(now - last);
      last = now;
      const bounds = viewport();
      const cards = Array.from(document.querySelectorAll(".cooking-db__card")).filter((card) => {
        const rect = card.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
      });
      let invalid = 0;
      let errors = 0;
      let ready = 0;
      let noCover = 0;
      for (const card of cards) {
        const state = (card as HTMLElement).dataset.imageState;
        if (state !== "ready" && state !== "none" && state !== "error") invalid += 1;
        if (!state) blankFrames += 1;
        if (state === "error") {
          errorFrames += 1;
          errors += 1;
          errorPaths.add((card as HTMLElement).dataset.path ?? "");
        }
        if (state === "ready") ready += 1;
        if (state === "none") noCover += 1;
      }
      maxInvalidCards = Math.max(maxInvalidCards, invalid);
      maxErrorCards = Math.max(maxErrorCards, errors);
      minReadyCards = Math.min(minReadyCards, ready);
      maxNoCoverCards = Math.max(maxNoCoverCards, noCover);
    };
    let running = true;
    const monitor = (now: number) => {
      sample(now);
      if (running) requestAnimationFrame(monitor);
    };
    scrollElement.scrollTop = 0;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    requestAnimationFrame(monitor);
    const maxScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const step = (now: number) => {
        const progress = Math.min(1, (now - start) / 700);
        scrollElement.scrollTop = maxScroll * progress;
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    running = false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const sorted = [...gaps].sort((a, b) => a - b);
    return {
      p95FrameGapMs: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
      blankFrames,
      errorFrames,
      maxErrorCards,
      minReadyCards: Number.isFinite(minReadyCards) ? minReadyCards : 0,
      maxNoCoverCards,
      errorPaths: [...errorPaths].slice(0, 12),
      maxInvalidCards
    };
  });
}

function getBoardSnapshot(page: Page): Promise<BoardSnapshot[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".kanban-board[data-id]")).map((board) => ({
    id: (board as HTMLElement).dataset.id ?? "",
    itemIds: Array.from(board.querySelectorAll(".kanban-item[data-eid]")).map(
      (item) => (item as HTMLElement).dataset.eid ?? ""
    ),
  })));
}

function summarizeBoard(snapshot: BoardSnapshot[], boardId: string, itemKey: string) {
  const board = snapshot.find((entry) => entry.id === boardId);
  if (!board) return { id: boardId, count: 0, index: -1, neighbors: [] };
  const index = board.itemIds.findIndex((itemId) => itemId === itemKey || itemId.startsWith(`${itemKey}::`));
  return {
    id: board.id,
    count: board.itemIds.length,
    index,
    neighbors: index < 0 ? [] : board.itemIds.slice(Math.max(0, index - 1), index + 2),
  };
}

async function waitForPlannerReconciliation(page: Page): Promise<void> {
  await expect.poll(
    async () => page.evaluate(() => (window as Window & { __mepPlannerRefreshApplied?: number }).__mepPlannerRefreshApplied ?? 0),
    { timeout: 10000, message: "Expected the organiser watcher/reconciliation refresh after planner drop." }
  ).toBeGreaterThan(0);
}

async function waitForStableBoard(page: Page): Promise<BoardSnapshot[]> {
  return page.evaluate(async () => {
    const snapshot = () => JSON.stringify(Array.from(document.querySelectorAll(".kanban-board[data-id]")).map((board) => ({
      id: (board as HTMLElement).dataset.id ?? "",
      itemIds: Array.from(board.querySelectorAll(".kanban-item[data-eid]")).map(
        (item) => (item as HTMLElement).dataset.eid ?? ""
      ),
    })));
    let previous = snapshot();
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = snapshot();
      if (current === previous) return JSON.parse(current) as BoardSnapshot[];
      previous = current;
    }
    return JSON.parse(previous) as BoardSnapshot[];
  });
}

test("visual stability harness records deterministic interaction measurements", async ({ page }, testInfo) => {
  const result: Record<string, unknown> = {
    fixture: "visual",
    runtime: {
      browser: testInfo.project.name,
      viewport: page.viewportSize(),
      userAgent: await page.evaluate(() => navigator.userAgent),
    },
  };

  const firstPaint = await waitForDatabaseReady(page);
  const recipeCount = await page.locator(".cooking-db__count").innerText();
  result.recipeCount = recipeCount;
  result.databaseFirstPaint = firstPaint;
  expect(Number(recipeCount.match(/\d+/)?.[0] ?? 0)).toBeGreaterThanOrEqual(500);

  // Install a layout-shift observer before the first recipe open.
  await page.evaluate(() => {
    (window as Window & { __mepLayoutObserver?: PerformanceObserver }).__mepLayoutObserver?.disconnect();
    let total = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) total += shift.value ?? 0;
      }
      (window as Window & { __mepLayoutShifts?: number }).__mepLayoutShifts = total;
    });
    observer.observe({ type: "layout-shift", buffered: false });
    (window as Window & { __mepLayoutObserver?: PerformanceObserver }).__mepLayoutObserver = observer;
  });

  const firstCard = page.locator(".cooking-db__card").first();
  await page.evaluate(() => {
    let seen = false;
    const mark = () => {
      if ((document.body.textContent ?? "").includes("Loading recipe view…")) seen = true;
    };
    const observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    (window as Window & { __mepRecipeLoadingFallback?: { seen: () => boolean; observer: MutationObserver } }).__mepRecipeLoadingFallback = {
      seen: () => seen,
      observer,
    };
  });
  await page.evaluate(() => {
    (window as Window & { __mepLayoutObserver?: PerformanceObserver }).__mepLayoutObserver?.disconnect();
    (window as Window & { __mepLayoutShifts?: number }).__mepLayoutShifts = 0;
    let total = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) total += shift.value ?? 0;
      }
      (window as Window & { __mepLayoutShifts?: number }).__mepLayoutShifts = total;
    });
    observer.observe({ type: "layout-shift", buffered: false });
    (window as Window & { __mepLayoutObserver?: PerformanceObserver }).__mepLayoutObserver = observer;
  });
  const openStart = await page.evaluate(() => performance.now());
  await firstCard.click();
  await expect(page.locator(".recipe-view--full")).toBeVisible();
  expect(await page.evaluate(() => {
    const state = (window as Window & { __mepRecipeLoadingFallback?: { seen: () => boolean; observer: MutationObserver } }).__mepRecipeLoadingFallback;
    state?.observer.disconnect();
    return state?.seen() ?? false;
  })).toBe(false);
  await expect.poll(async () => page.locator(".recipe-view__image img").count()).toBeGreaterThan(0);
  const view = await stableRecipeView(page);
  result.recipeOpen = {
    clickToStableMs: Math.round((await page.evaluate(() => performance.now())) - openStart),
    layoutShifts: view.layoutShifts,
    aboveFoldImages: view.aboveFoldImages,
    syntheticImages: view.syntheticImages,
    incompleteAboveFoldImages: view.incompleteImages,
  };
  expect(view.incompleteImages).toBe(0);
  expect(view.aboveFoldImages).toBeGreaterThan(0);
  expect(view.layoutShifts).toBeLessThan(0.01);

  await page.locator('button.mep-nav__item:has-text("Recipe Database")').click();
  await waitForDatabaseReady(page);

  const search = page.locator(".cooking-db__search");
  await page.evaluate(() => {
    const tracker = { minCards: Number.POSITIVE_INFINITY, observer: null as MutationObserver | null };
    const sample = () => {
      tracker.minCards = Math.min(tracker.minCards, document.querySelectorAll(".cooking-db__card").length);
    };
    sample();
    tracker.observer = new MutationObserver(sample);
    tracker.observer.observe(document.body, { childList: true, subtree: true });
    (window as Window & { __mepDatabaseTransition?: typeof tracker }).__mepDatabaseTransition = tracker;
  });
  const searchStart = await page.evaluate(() => performance.now());
  await search.pressSequentially("Visual Fixture 257", { delay: 8 });
  await expect.poll(async () => page.locator(".cooking-db__card").count()).toBe(1);
  result.search = {
    inputToResultsMs: Math.round((await page.evaluate(() => performance.now())) - searchStart),
    resultPath: await page.locator(".cooking-db__card").getAttribute("data-path"),
  };
  const transitionMinCards = await page.evaluate(() => {
    const tracker = (window as Window & { __mepDatabaseTransition?: { minCards: number; observer?: MutationObserver } }).__mepDatabaseTransition;
    tracker?.observer?.disconnect();
    return Number.isFinite(tracker?.minCards) ? tracker!.minCards : 0;
  });
  result.databaseTransitionMinCards = transitionMinCards;
  expect(transitionMinCards).toBeGreaterThan(0);

  await search.fill("");
  await expect.poll(async () => page.locator(".cooking-db__card").count()).toBeGreaterThan(1);

  // Exercise a non-zero anchor through twenty duplicate-primary mark/unmark
  // mutations. The fixture has 32 recipes with the same added date.
  await search.fill("Duplicate Date Fixture");
  await expect.poll(async () => page.locator(".cooking-db__card").count()).toBeGreaterThanOrEqual(20);
  const duplicatePaths = await page.locator(".cooking-db__card").evaluateAll((cards) =>
    cards
      .filter((card) => !(card.querySelector("input") as HTMLInputElement | null)?.checked)
      .map((card) => (card as HTMLElement).dataset.path ?? "")
      .filter(Boolean)
      .slice(0, 20)
  );
  expect(duplicatePaths).toHaveLength(20);
  const scrollAnchorBefore = await page.evaluate(async () => {
    const root = document.querySelector(".cooking-db__grid-container");
    const scrollElement = [root, ...Array.from(root?.querySelectorAll("*") ?? [])].find((element) => {
      const node = element as HTMLElement;
      return node.scrollHeight > node.clientHeight + 40 && node.style.overflowY !== "hidden";
    }) as HTMLElement | undefined;
    if (!scrollElement) throw new Error("Missing scrollable recipe grid element.");
    scrollElement.scrollTop = Math.min(420, Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return scrollElement.scrollTop;
  });
  expect(scrollAnchorBefore).toBeGreaterThan(0);
  const anchorCandidates = (await getVisibleCards(page)).filter((card) => card.top >= 0 && card.top < (page.viewportSize()?.height ?? 720));
  const anchorPath = anchorCandidates[0]?.path;
  expect(anchorPath).toBeTruthy();
  const anchorBefore = anchorCandidates.find((card) => card.path === anchorPath);
  expect(anchorBefore).toBeTruthy();

  const assertAnchorStable = async () => {
    const after = (await getVisibleCards(page)).find((card) => card.path === anchorPath);
    expect(after?.index).toBe(anchorBefore!.index);
    expect(after ? Math.hypot(after.left - anchorBefore!.left, after.top - anchorBefore!.top) : Infinity).toBeLessThan(1);
  };
  for (const path of duplicatePaths) {
    const card = page.locator(`.cooking-db__card[data-path="${path}"]`);
    await card.locator("input").evaluate((input) => (input as HTMLInputElement).click());
    await expect(card.locator("input")).toBeChecked();
    await assertAnchorStable();
  }
  for (const path of duplicatePaths) {
    const card = page.locator(`.cooking-db__card[data-path="${path}"]`);
    await card.locator("input").evaluate((input) => (input as HTMLInputElement).click());
    await expect(card.locator("input")).not.toBeChecked();
    await assertAnchorStable();
  }
  result.duplicateDateMarkAnchoring = {
    duplicateDate: "2026-06-16",
    mutationCount: duplicatePaths.length * 2,
    anchorPath,
    anchorBefore,
    anchorAfter: (await getVisibleCards(page)).find((card) => card.path === anchorPath)
  };
  await search.fill("");
  await expect.poll(async () => page.locator(".cooking-db__card").count()).toBeGreaterThan(1);

  const beforeCards = await getVisibleCards(page);
  const targetCard = page.locator('.cooking-db__card').filter({ has: page.locator('input:not(:checked)') }).first();
  await expect(targetCard).toBeVisible();
  const targetPath = await targetCard.getAttribute("data-path");
  const targetCardByPath = page.locator(`.cooking-db__card[data-path="${targetPath}"]`);
  const unaffectedBefore = beforeCards.find((card) => card.path !== targetPath);
  expect(targetPath).toBeTruthy();
  expect(unaffectedBefore).toBeTruthy();
  await targetCardByPath.locator("input").check();
  await expect(targetCardByPath.locator("input")).toBeChecked();
  await expect(targetCardByPath.locator("input")).toBeEnabled();
  const afterCards = await getVisibleCards(page);
  const unaffectedAfter = afterCards.find((card) => card.path === unaffectedBefore!.path);
  result.markAnchoring = {
    targetPath,
    unaffectedPath: unaffectedBefore!.path,
    before: unaffectedBefore,
    after: unaffectedAfter,
    indexUnchanged: unaffectedAfter?.index === unaffectedBefore!.index,
    positionDeltaPx: unaffectedAfter
      ? Math.hypot(unaffectedAfter.left - unaffectedBefore!.left, unaffectedAfter.top - unaffectedBefore!.top)
      : null,
  };
  expect(unaffectedAfter?.index).toBe(unaffectedBefore!.index);

  const databaseScroll = await measureDatabaseScroll(page);
  result.databaseScroll = databaseScroll;
  expect(databaseScroll.maxInvalidCards).toBe(0);

  await page.locator('button.mep-nav__item:has-text("Planner")').click();
  await expect.poll(async () => page.locator(".kanban-board[data-id]").count()).toBeGreaterThan(1);
  await page.evaluate(() => {
    const globals = window as Window & {
      __mepPlannerRefreshApplied?: number;
      __mepPlannerOriginalDebug?: typeof console.debug;
    };
    globals.__mepPlannerRefreshApplied = 0;
    if (!globals.__mepPlannerOriginalDebug) {
      globals.__mepPlannerOriginalDebug = console.debug.bind(console);
      console.debug = (...args: unknown[]) => {
        if (args[0] === "[WeeklyOrganiser]" && args[1] === "refresh:applied") {
          globals.__mepPlannerRefreshApplied = (globals.__mepPlannerRefreshApplied ?? 0) + 1;
        }
        globals.__mepPlannerOriginalDebug?.(...args);
      };
    }
    (window as Window & { __MEP_KANBAN_DEBUG__?: boolean }).__MEP_KANBAN_DEBUG__ = true;
  });
  const beforeDrop = await getBoardSnapshot(page);
  const placement = await page.evaluate(() => {
    const boards = Array.from(document.querySelectorAll(".kanban-board[data-id]")) as HTMLElement[];
    const source = boards.find((board) => board.dataset.id !== "marked" && board.querySelector(".kanban-item[data-eid]"));
    const target = boards.find((board) => board.dataset.id !== "marked" && board !== source);
    if (!source || !target) return null;
    const item = source.querySelector(".kanban-item[data-eid]") as HTMLElement | null;
    const targetContainer = (target.querySelector(".kanban-drag") as HTMLElement | null) ?? target;
    if (!item) return null;
    const start = item.getBoundingClientRect();
    const end = targetContainer.getBoundingClientRect();
    return {
      itemId: item.dataset.eid ?? "",
      sourceId: source.dataset.id ?? "",
      targetId: target.dataset.id ?? "",
      start: { x: start.left + start.width / 2, y: start.top + start.height / 2 },
      end: { x: end.left + Math.min(40, Math.max(12, end.width / 4)), y: end.top + Math.min(100, Math.max(28, end.height / 3)) },
    };
  });
  expect(placement).toBeTruthy();
  await page.mouse.move(placement!.start.x, placement!.start.y);
  await page.mouse.down();
  await page.mouse.move(placement!.end.x, placement!.end.y, { steps: 12 });
  await page.mouse.up();
  const itemKey = placement!.itemId.split("::", 1)[0];
  const immediateAfterDrop = await getBoardSnapshot(page);
  const immediateSource = summarizeBoard(immediateAfterDrop, placement!.sourceId, itemKey);
  const immediateTarget = summarizeBoard(immediateAfterDrop, placement!.targetId, itemKey);
  await waitForPlannerReconciliation(page);
  const settledAfterDrop = await waitForStableBoard(page);
  const settledTarget = summarizeBoard(settledAfterDrop, placement!.targetId, itemKey);
  const settledSource = summarizeBoard(settledAfterDrop, placement!.sourceId, itemKey);
  expect(settledAfterDrop.find((board) => board.id === placement!.sourceId)?.itemIds)
    .toEqual(immediateAfterDrop.find((board) => board.id === placement!.sourceId)?.itemIds);
  expect(settledAfterDrop.find((board) => board.id === placement!.targetId)?.itemIds)
    .toEqual(immediateAfterDrop.find((board) => board.id === placement!.targetId)?.itemIds);
  expect(settledSource).toEqual(immediateSource);
  expect(settledTarget).toEqual(immediateTarget);
  expect(settledTarget.index).toBe(immediateTarget.index);
  expect(settledTarget.neighbors).toEqual(immediateTarget.neighbors);
  result.plannerDrop = {
    placement,
    itemKey,
    before: {
      source: summarizeBoard(beforeDrop, placement!.sourceId, itemKey),
      target: summarizeBoard(beforeDrop, placement!.targetId, itemKey),
    },
    immediateAfter: {
      source: summarizeBoard(immediateAfterDrop, placement!.sourceId, itemKey),
      target: immediateTarget,
    },
    settledAfter: {
      source: summarizeBoard(settledAfterDrop, placement!.sourceId, itemKey),
      target: settledTarget,
    },
    observed: Boolean(
      immediateTarget.index >= 0 || settledTarget.index >= 0
    ),
  };

  const payload = `${JSON.stringify(result, null, 2)}\n`;
  console.log(`[VISUAL_STABILITY] ${payload}`);
  await testInfo.attach("visual-stability.json", { body: Buffer.from(payload), contentType: "application/json" });
});
