#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = process.env.MEP_ROUTE_BENCHMARK_URL || "http://127.0.0.1:4173/";
const RUNS = 5;
const VIEWPORT = { width: 1440, height: 1000 };
const ROUTE_TIMEOUT_MS = 30000;
const ROUTE_PAINT_P95_MS = 100;
const DETAIL_PAINT_P95_MS = 130;
const DETAIL_MAX_WIDTH_PX = 720;
const DETAIL_MAX_HEIGHT_PX = 640;
const GEOMETRY_TOLERANCE_PX = 1;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
  return {
    min: Math.min(...values),
    median: percentile(0.5),
    p95: percentile(0.95),
    max: Math.max(...values)
  };
}

export function evaluateBaseline(summary) {
  if (!summary || typeof summary !== "object") {
    return ["benchmark summary is missing"];
  }
  const failures = [];
  if (summary.completedRuns !== RUNS) failures.push(`completed runs ${summary.completedRuns} != ${RUNS}`);
  if ((summary.fallbackFrames?.database?.max ?? 0) > 0) failures.push("Recipe Database fallback frames observed");
  if ((summary.fallbackFrames?.health?.max ?? 0) > 0) failures.push("Cooking Health fallback frames observed");
  for (const label of ["database", "health"]) {
    const value = summary.routePaintMs?.[label];
    if ((value?.p95 ?? Infinity) > ROUTE_PAINT_P95_MS) failures.push(`${label} paint p95 ${value.p95}ms > ${ROUTE_PAINT_P95_MS}ms`);
  }
  for (const label of ["detail", "reopenDetail"]) {
    const value = summary.routePaintMs?.[label];
    if ((value?.p95 ?? Infinity) > DETAIL_PAINT_P95_MS) failures.push(`${label} paint p95 ${value.p95}ms > ${DETAIL_PAINT_P95_MS}ms`);
  }
  if ((summary.detailStability?.blankFrames?.max ?? 1) > 0) failures.push("detail blank frames observed after route visibility");
  if ((summary.detailStability?.sourceSwapFrames?.max ?? 1) > 0) failures.push("detail image source swaps observed after route visibility");
  if (!Array.isArray(summary.samples) || summary.samples.length !== RUNS) {
    failures.push(`detail samples must contain exactly ${RUNS} runs`);
  }
  for (const [index, samples] of (Array.isArray(summary.samples) ? summary.samples : []).entries()) {
    if (samples.length < 3) failures.push(`run ${index + 1} has fewer than 3 detail samples`);
    if (!samples.some((sample) => sample.label === "first-visible")) failures.push(`run ${index + 1} lacks first-visible detail sample`);
    if (!samples.some((sample) => sample.label === "portrait-source")) failures.push(`run ${index + 1} lacks portrait-source detail sample`);
    if (!samples.some((sample) => sample.label === "middle-dataset")) failures.push(`run ${index + 1} lacks middle-dataset detail sample`);
  }
  if (!Array.isArray(summary.geometry) || summary.geometry.length !== RUNS) {
    failures.push(`cover geometry must contain exactly ${RUNS} runs`);
  }
  for (const [index, geometry] of (Array.isArray(summary.geometry) ? summary.geometry : []).entries()) {
    const aspectRange = geometry.coverAspectRange;
    const heightRange = geometry.coverHeightRange;
    if (!geometry.portraitCount || !geometry.landscapeCount) failures.push(`run ${index + 1} lacks portrait/landscape cover evidence`);
    if (!aspectRange || aspectRange.max - aspectRange.min > 0.01) failures.push(`run ${index + 1} cover aspect range is not uniform`);
    if (!heightRange || heightRange.max - heightRange.min > GEOMETRY_TOLERANCE_PX) failures.push(`run ${index + 1} cover height range exceeds ${GEOMETRY_TOLERANCE_PX}px`);
  }
  for (const evidence of summary.detailEvidence ?? []) {
    for (const [label, detail] of [["detail", evidence.detail], ["reopen", evidence.reopen]]) {
      if ((detail?.imageRect?.width ?? Infinity) > DETAIL_MAX_WIDTH_PX) failures.push(`${label} image width ${detail.imageRect.width}px > ${DETAIL_MAX_WIDTH_PX}px`);
      const maxHeight = Math.min((detail?.viewport?.height ?? Infinity) * 0.6, DETAIL_MAX_HEIGHT_PX);
      if ((detail?.imageRect?.height ?? Infinity) > maxHeight) failures.push(`${label} image height ${detail.imageRect.height}px > ${maxHeight}px`);
      if (detail?.contentColumnLeft !== null && detail?.contentColumnLeft !== undefined && Math.abs(detail.imageRect.left - detail.contentColumnLeft) > 1) failures.push(`${label} image is not left-aligned to its content column`);
      if ((detail?.bannerTexts?.length ?? 0) > 0) failures.push(`${label} figcaption/banner text detected`);
      if ((detail?.cardCoverGeometry?.width ?? 0) <= 0 || (detail?.cardCoverGeometry?.height ?? 0) <= 0) failures.push(`${label} sampled card cover geometry is missing`);
    }
  }
  return [...new Set(failures)];
}

function installDiagnostics(page) {
  const consoleDiagnostics = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleDiagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => consoleDiagnostics.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()}: ${request.failure()?.errorText ?? "unknown"}`);
  });
  return { consoleDiagnostics, failedRequests };
}

async function clickRoute(page, label, target) {
  return page.evaluate(async ({ label, target }) => {
    const button = [...document.querySelectorAll("button.mep-nav__item")]
      .find((element) => element.textContent?.includes(label));
    if (!button) throw new Error(`Missing ${label} navigation button.`);
    const started = performance.now();
    button.click();
    let fallbackSeen = false;
    let fallbackFrames = 0;
    return await new Promise((resolve, reject) => {
      const deadline = started + 30000;
      const frame = (now) => {
        const fallback = [...document.querySelectorAll(".mep-loading")]
          .some((element) => element.textContent?.trim());
        if (fallback) {
          fallbackSeen = true;
          fallbackFrames += 1;
        }
        const rendered = document.querySelector(target);
        if (rendered) {
          resolve({ paintMs: Math.max(0, Math.round(now - started)), fallbackSeen, fallbackFrames });
          return;
        }
        if (now >= deadline) {
          reject(new Error(`${label} route did not render ${target} within 30000ms.`));
          return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }, { label, target });
}

async function measureDetail(page, sample = null) {
  const path = typeof sample === "string" ? sample : sample?.path ?? null;
  const label = typeof sample === "string" ? "recipe" : sample?.label ?? "recipe";
  return page.evaluate(async ({ path, label }) => {
    const card = path
      ? [...document.querySelectorAll(".cooking-db__card")].find((element) => element.getAttribute("data-path") === path)
      : [...document.querySelectorAll('.cooking-db__card[data-has-cover="true"]')][0];
    if (!card) throw new Error("Missing covered recipe card.");
    const selectedPath = card.getAttribute("data-path");
    if (label === "middle-dataset") card.scrollIntoView({ block: "center", inline: "nearest" });
    if (label === "first-visible") card.scrollIntoView({ block: "start", inline: "nearest" });
    const cardRect = card.getBoundingClientRect();
    const coverRect = card.querySelector(".cooking-db__cover")?.getBoundingClientRect();
    const cardCoverGeometry = coverRect ? {
      width: coverRect.width,
      height: coverRect.height,
      aspect: coverRect.width / coverRect.height,
      cardWidth: cardRect.width,
      cardHeight: cardRect.height
    } : null;
    const started = performance.now();
    card.click();
    const waitFor = async (predicate, timeout = 30000) => {
      const deadline = performance.now() + timeout;
      return await new Promise((resolve, reject) => {
        const frame = (now) => {
          const value = predicate();
          if (value) {
            resolve(value);
            return;
          }
          if (now >= deadline) {
            reject(new Error("Timed out waiting for recipe detail image."));
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    };
    await waitFor(() => document.querySelector(".recipe-view"));
    const routeVisibleMs = Math.max(0, Math.round(performance.now() - started));
    const image = await waitFor(() => {
      const candidate = document.querySelector(".recipe-view img");
      if (!candidate || !candidate.complete || candidate.naturalWidth <= 0 || candidate.naturalHeight <= 0) return null;
      return candidate;
    });
    try {
      await image.decode?.();
    } catch {
      throw new Error("Recipe detail image decode failed.");
    }
    const firstDecodedPaintMs = Math.max(0, Math.round(performance.now() - started));
    const initialSource = image.currentSrc || image.src;
    let previousRect = null;
    const initialRect = await waitFor(() => {
      const current = document.querySelector(".recipe-view img");
      if (!current) return null;
      const rect = current.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const next = rect.toJSON();
      const stable = previousRect && Math.abs(next.x - previousRect.x) <= 0.5 && Math.abs(next.y - previousRect.y) <= 0.5 && Math.abs(next.width - previousRect.width) <= 0.5 && Math.abs(next.height - previousRect.height) <= 0.5;
      previousRect = next;
      return stable ? next : null;
    });
    const methodPane = document.querySelector(".recipe-view__method-pane");
    const contentColumn = methodPane ?? document.querySelector(".recipe-view__mdx, .recipe-view__content");
    const contentRect = contentColumn?.getBoundingClientRect();
    const contentPaddingLeft = contentColumn ? Number.parseFloat(getComputedStyle(contentColumn).paddingLeft || "0") : 0;
    const contentColumnLeft = contentRect ? contentRect.left + contentPaddingLeft : null;
    let blankFrames = 0;
    let sourceSwapFrames = 0;
    let geometryChangeFrames = 0;
    for (let frameIndex = 0; frameIndex < 30; frameIndex += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const current = document.querySelector(".recipe-view img");
      const rect = current?.getBoundingClientRect();
      if (!current || !current.complete || current.naturalWidth <= 0 || current.naturalHeight <= 0) blankFrames += 1;
      if ((current?.currentSrc || current?.src || "") !== initialSource) sourceSwapFrames += 1;
      if (rect && (Math.abs(rect.x - initialRect.x) > 0.5 || Math.abs(rect.y - initialRect.y) > 0.5 || Math.abs(rect.width - initialRect.width) > 0.5 || Math.abs(rect.height - initialRect.height) > 0.5)) geometryChangeFrames += 1;
    }
    const fixedBottomText = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return (style.position === "fixed" || style.position === "sticky") && element.textContent?.trim();
      })
      .map((element) => element.textContent.trim())
      .filter((text, index, values) => values.indexOf(text) === index)
      .slice(0, 10);
    const bannerTexts = [...document.querySelectorAll("figcaption, [class*='banner'], [class*='overlay']")]
      .map((element) => element.textContent?.trim())
      .filter(Boolean)
      .filter((text, index, values) => values.indexOf(text) === index);
    return {
      label,
      path: selectedPath,
      routeVisibleMs,
      firstDecodedPaintMs,
      blankFrames,
      sourceSwapFrames,
      geometryChangeFrames,
      imageSource: initialSource,
      imageNatural: { width: image.naturalWidth, height: image.naturalHeight },
      cardCoverGeometry,
      imageRect: initialRect,
      viewport: { width: innerWidth, height: innerHeight },
      contentColumnLeft,
      bottomGapPx: Math.round(innerHeight - (initialRect.y + initialRect.height)),
      fixedBottomText,
      bannerTexts
    };
  }, { path, label });
}

async function measureCoverGeometry(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.cooking-db__card[data-has-cover="true"]')];
    const covers = cards.map((card) => {
      const cover = card.querySelector(".cooking-db__cover");
      const image = card.querySelector("img");
      const rect = cover?.getBoundingClientRect();
      return rect && image ? {
        coverWidth: rect.width,
        coverHeight: rect.height,
        coverAspect: rect.width / rect.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        sourceAspect: image.naturalWidth / image.naturalHeight
      } : null;
    }).filter(Boolean);
    const portraits = covers.filter((cover) => cover.naturalHeight > cover.naturalWidth);
    const landscapes = covers.filter((cover) => cover.naturalWidth > cover.naturalHeight);
    const range = (values) => values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) };
    return {
      cardCount: cards.length,
      renderedCoverCount: covers.length,
      portraitCount: portraits.length,
      landscapeCount: landscapes.length,
      coverAspectRange: range(covers.map((cover) => cover.coverAspect)),
      coverHeightRange: range(covers.map((cover) => cover.coverHeight)),
      portraitCoverAspectRange: range(portraits.map((cover) => cover.coverAspect)),
      landscapeCoverAspectRange: range(landscapes.map((cover) => cover.coverAspect)),
      portraitCoverHeightRange: range(portraits.map((cover) => cover.coverHeight)),
      landscapeCoverHeightRange: range(landscapes.map((cover) => cover.coverHeight))
    };
  });
}

async function selectRecipeSamples(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.cooking-db__card[data-has-cover="true"]')];
    if (cards.length < 3) throw new Error(`Need at least 3 covered recipes, found ${cards.length}.`);
    const sourceKind = (card) => {
      const image = card.querySelector("img");
      if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return "unknown";
      return image.naturalHeight > image.naturalWidth ? "portrait" : "landscape";
    };
    const first = cards[0];
    const portrait = cards.find((card, index) => index > 0 && sourceKind(card) === "portrait")
      ?? cards.find((card) => sourceKind(card) === "portrait");
    const middleIndex = Math.floor((cards.length - 1) / 2);
    const middle = cards[middleIndex];
    const selections = [
      { label: "first-visible", card: first },
      { label: "portrait-source", card: portrait },
      { label: "middle-dataset", card: middle }
    ];
    const unique = [];
    for (const selection of selections) {
      if (!selection.card) continue;
      const path = selection.card.getAttribute("data-path");
      if (!path || unique.some((item) => item.path === path)) continue;
      unique.push({ label: selection.label, path, sourceKind: sourceKind(selection.card), index: cards.indexOf(selection.card) });
    }
    if (unique.length < 3) throw new Error("Covered recipe samples did not span three distinct cards.");
    return unique;
  });
}

async function runOne(page, url) {
  const diagnostics = installDiagnostics(page);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(globalThis.__MEP_REMOTE_HOST__) || globalThis.__MEP_SHIM_FIXTURE_ID__ === "visual-v1", undefined, { timeout: 10000 });
    await page.waitForSelector('button.mep-nav__item:has-text("Recipe Database")', { state: "visible", timeout: ROUTE_TIMEOUT_MS });
    const database = await clickRoute(page, "Recipe Database", ".cooking-db");
    await page.waitForSelector('.cooking-db__card[data-has-cover="true"]', { state: "visible", timeout: ROUTE_TIMEOUT_MS });
    await page.waitForFunction(() => [...document.querySelectorAll('.cooking-db__card[data-has-cover="true"]')].every((card) => {
      const image = card.querySelector("img");
      return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }), undefined, { timeout: ROUTE_TIMEOUT_MS });
    const geometry = await measureCoverGeometry(page);
    const samples = await selectRecipeSamples(page);
    const details = [];
    for (const sample of samples) {
      const detail = await measureDetail(page, sample);
      await page.click('button.mep-nav__item:has-text("Recipe Database")');
      await page.waitForSelector(".cooking-db", { state: "visible", timeout: ROUTE_TIMEOUT_MS });
      const reopen = await measureDetail(page, sample);
      details.push({ sample, detail, reopen });
      if (sample !== samples[samples.length - 1]) {
        await page.click('button.mep-nav__item:has-text("Recipe Database")');
        await page.waitForSelector(".cooking-db", { state: "visible", timeout: ROUTE_TIMEOUT_MS });
      }
    }
    const health = await clickRoute(page, "Cooking Health", ".cooking-health");
    return { database, health, geometry, details, diagnostics };
  } catch (error) {
    error.diagnostics = diagnostics;
    throw error;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: process.env.MEP_ROUTE_BENCHMARK_HEADED !== "1" });
  const runs = [];
  try {
    for (let index = 0; index < RUNS; index += 1) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      try {
        const result = await runOne(page, DEFAULT_URL);
        runs.push(result);
        const detailP95 = Math.max(...result.details.map((entry) => entry.detail.firstDecodedPaintMs));
        const reopenP95 = Math.max(...result.details.map((entry) => entry.reopen.firstDecodedPaintMs));
        const blankFrames = result.details.reduce((sum, entry) => sum + entry.detail.blankFrames + entry.reopen.blankFrames, 0);
        const sourceSwaps = result.details.reduce((sum, entry) => sum + entry.detail.sourceSwapFrames + entry.reopen.sourceSwapFrames, 0);
        console.log(`run=${index + 1} db=${result.database.paintMs}ms health=${result.health.paintMs}ms detailMax=${detailP95}ms reopenMax=${reopenP95}ms blank=${blankFrames} swaps=${sourceSwaps}`);
      } catch (error) {
        runs.push({ error: errorMessage(error), diagnostics: error.diagnostics ?? { consoleDiagnostics: [], failedRequests: [] } });
        console.error(`run=${index + 1} failed: ${errorMessage(error)}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const completed = runs.filter((run) => !run.error);
  const detailEvidence = completed.flatMap((run) => run.details);
  const summary = {
    url: DEFAULT_URL,
    runs: RUNS,
    completedRuns: completed.length,
    viewport: VIEWPORT,
    targets: {
      routeFallbackFrames: 0,
      routePaintP95Ms: ROUTE_PAINT_P95_MS,
      detailPaintP95Ms: DETAIL_PAINT_P95_MS,
      warmRouteDetailP95Ms: DETAIL_PAINT_P95_MS,
      detailBlankFrames: 0,
      detailSourceSwapFrames: 0,
      uniformCoverGeometry: true,
      coverGeometryTolerancePx: GEOMETRY_TOLERANCE_PX,
      detailMaxWidthPx: DETAIL_MAX_WIDTH_PX,
      detailMaxHeightPx: DETAIL_MAX_HEIGHT_PX,
      existingScrollContract: { imageResponses: 0, imageBytes: 0, frameP95Ms: 16.8, severeFrames: 0 }
    },
    routePaintMs: {
      database: summarize(completed.map((run) => run.database.paintMs)),
      health: summarize(completed.map((run) => run.health.paintMs)),
      detail: summarize(detailEvidence.map((entry) => entry.detail.firstDecodedPaintMs)),
      reopenDetail: summarize(detailEvidence.map((entry) => entry.reopen.firstDecodedPaintMs))
    },
    fallbackFrames: {
      database: summarize(completed.map((run) => run.database.fallbackFrames)),
      health: summarize(completed.map((run) => run.health.fallbackFrames)),
      databaseSeen: completed.some((run) => run.database.fallbackSeen),
      healthSeen: completed.some((run) => run.health.fallbackSeen)
    },
    detailStability: {
      blankFrames: summarize(detailEvidence.map((entry) => entry.detail.blankFrames + entry.reopen.blankFrames)),
      sourceSwapFrames: summarize(detailEvidence.map((entry) => entry.detail.sourceSwapFrames + entry.reopen.sourceSwapFrames)),
      geometryChangeFrames: summarize(detailEvidence.map((entry) => entry.detail.geometryChangeFrames + entry.reopen.geometryChangeFrames))
    },
    geometry: completed.map((run) => run.geometry),
    samples: completed.map((run) => run.details.map((entry) => entry.sample)),
    detailEvidence,
    consoleDiagnostics: completed.flatMap((run) => run.diagnostics.consoleDiagnostics),
    failedRequests: completed.flatMap((run) => run.diagnostics.failedRequests),
    failures: runs.filter((run) => run.error).map((run) => run.error)
  };
  summary.failures = evaluateBaseline(summary);
  const output = process.env.MEP_ROUTE_BENCHMARK_OUTPUT || "/tmp/recipe-route-baseline.json";
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`summary=${JSON.stringify(summary)}`);
  console.log(`wrote=${output}`);
  if (summary.failures.length > 0) {
    console.error(`route baseline failed: ${summary.failures.join("; ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`route baseline failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
