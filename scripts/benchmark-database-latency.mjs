#!/usr/bin/env node
// Measurement harness for database initial-load latency (cold-load path).
//
// Usage (from repository root):
//   node scripts/benchmark-database-cold-load.mjs [--runs 3|5] [--output <path>] [--headed]
//
// Each sample launches a fresh Chromium browser process (cold user-data dir),
// creates a fresh 500-PNG fixture + empty appdata, starts an isolated web host
// + Rust helper, installs PerformanceObserver (element + mark + longtask) via
// context.addInitScript before any page is created, navigates to /database,
// and waits on a single promise (page.evaluate, no polling) that resolves when
// the semantic-ready mark's exact first-four paths all have matching
// PerformanceElementTiming entries AND the all-covers mark has fired.
// After the primary window closes, DOM correctness checks verify all 500 cards
// have natural image dimensions > 0, no error states, and exact fixture order.
//
// Flags:
//   --runs 3|5     Number of samples (default 3)
//   --output <path> Write JSON summary to <path>
//   --headed        Run browser headed (default headless)

import { chromium } from "@playwright/test";
import {
  access,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRecipeScrollFixture, RECIPE_SCROLL_FIXTURE_COUNT } from "./generate-recipe-scroll-fixture.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_RUNS = 3;
const DEADLINE_MS = 30_000;
const HOST_START_TIMEOUT_MS = 60_000;
const HOST_SHUTDOWN_GRACE_MS = 5_000;
const VIEWPORT = { width: 1440, height: 1000 };
const EXPECTED_COUNT = RECIPE_SCROLL_FIXTURE_COUNT;
const MAX_HOST_OUTPUT_TAIL_CHARS = 12_000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(`[db-cold]`, ...args);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const result = {
    runs: Number(process.env.MEP_DB_COLD_RUNS || DEFAULT_RUNS),
    output: process.env.MEP_DB_COLD_OUTPUT || null,
    headless: process.env.MEP_DB_COLD_HEADLESS !== "false",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--runs" && i + 1 < argv.length) {
      result.runs = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--output" && i + 1 < argv.length) {
      result.output = argv[i + 1];
      i += 1;
    } else if (token === "--headed") {
      result.headless = false;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function findRustHelper() {
  const candidates = [
    process.env.MEP_REMOTE_HOST_HELPER,
    "target/release/mep-remote-host-helper",
    "target/debug/mep-remote-host-helper",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch {
      // try next
    }
  }
  log("Building mep-remote-host-helper...");
  await execFileAsync("npm", ["run", "build:remote-helper"], { stdio: "inherit" });
  return path.resolve("target/debug/mep-remote-host-helper");
}

function appendOutputTail(previous, chunk) {
  const next = `${previous}${String(chunk)}`;
  return next.length > MAX_HOST_OUTPUT_TAIL_CHARS
    ? next.slice(-MAX_HOST_OUTPUT_TAIL_CHARS)
    : next;
}

// ---------------------------------------------------------------------------
// Statistics (nearest-rank percentile, matching benchmark-recipe-scroll)
// ---------------------------------------------------------------------------

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function median(sorted) {
  return percentile(sorted, 50);
}

function summarize(name, values) {
  const sorted = [...values].filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((a, b) => a - b);
  return {
    metric: name,
    n: sorted.length,
    min: sorted[0] ?? null,
    median: median(sorted),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Build (once)
// ---------------------------------------------------------------------------

async function buildWebOnce() {
  log("Building dist-web once before measured samples...");
  await execFileAsync("npm", ["run", "build"], { stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// Isolated web host (per sample)
// ---------------------------------------------------------------------------

async function startIsolatedWebHost({ fixture, helper, thumbnailCache }) {
  const port = await findFreePort();
  const child = spawn(
    "node",
    [
      "scripts/start-web-host.mjs",
      "--vault", fixture.vaultRoot,
      "--appdata", fixture.appDataRoot,
      "--thumbnail-cache", thumbnailCache,
      "--rust-helper", helper,
      "--host", "127.0.0.1",
      "--port", String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );

  const url = `http://127.0.0.1:${port}/database`;
  let stdoutTail = "";
  let stderrTail = "";
  let combinedTail = "";

  const started = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      combinedTail = appendOutputTail(combinedTail, chunk);
      if (/web host listening on http:\/\//.test(combinedTail)) resolve();
    };
    child.stdout.on("data", (chunk) => {
      stdoutTail = appendOutputTail(stdoutTail, chunk);
      onData(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = appendOutputTail(stderrTail, chunk);
      onData(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        const error = new Error(`isolated web host exited (${code})`);
        error.hostOutputTail = { stdout: stdoutTail, stderr: stderrTail, combined: combinedTail };
        reject(error);
      }
    });
  });

  try {
    await withTimeout(started, HOST_START_TIMEOUT_MS, "isolated web host startup");
  } catch (error) {
    child.kill("SIGTERM");
    if (!error.hostOutputTail) {
      error.hostOutputTail = { stdout: stdoutTail, stderr: stderrTail, combined: combinedTail };
    }
    throw error;
  }

  return {
    url,
    hostOutputTail: () => ({ stdout: stdoutTail, stderr: stderrTail, combined: combinedTail }),
    close: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, HOST_SHUTDOWN_GRACE_MS);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Browser init script (injected via context.addInitScript)
//
// Sets up PerformanceObserver for mark/element/longtask entries and exposes
// a single promise on window.__mepDbColdEndpoint that resolves when:
//   1. The semantic-ready mark has fired (providing firstFourPaths in detail).
//   2. The all-covers mark has fired.
//   3. PerformanceElementTiming entries for EXACTLY those first four paths
//      (matched by identifier) are present.
//
// The harness calls page.evaluate(() => window.__mepDbColdEndpoint) once
// and awaits the returned promise -- no polling.
// ---------------------------------------------------------------------------

function createInitScript() {
  return `(${observerSetup.toString()})()`;
}

function observerSetup() {
  if (performance && typeof performance.setResourceTimingBufferSize === "function") {
    performance.setResourceTimingBufferSize(2000);
  }
  var resolveEndpoint;
  var rejectEndpoint;
  window.__mepDbColdEndpoint = new Promise(function (resolve, reject) {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  window.__mepDbCold = {
    complete: false,
    marks: [],
    elements: [],
    longTasks: [],
    observerError: null,
    completionDetail: null,
  };

  function checkComplete() {
    if (window.__mepDbCold.complete) return;
    var semantic = window.__mepDbCold.marks.find(function (entry) {
      return entry.name === "mep:database:semantic-ready";
    });
    var targets = semantic && semantic.detail && semantic.detail.firstFourPaths;
    if (!Array.isArray(targets) || targets.length !== 4 || new Set(targets).size !== 4) return;
    var presentations = [];
    for (var targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      var target = targets[targetIndex];
      var candidates = window.__mepDbCold.elements.filter(function (entry) {
        return entry.identifier === target && Number(entry.renderTime) > 0;
      });
      if (candidates.length !== 1) return;
      presentations.push(candidates[0]);
    }
    window.__mepDbCold.complete = true;
    window.__mepDbCold.completionDetail = {
      targetPaths: targets.slice(),
      renderTimes: presentations.map(function (entry) { return entry.renderTime; }),
      endpointMs: Math.max.apply(Math, presentations.map(function (entry) { return entry.renderTime; })),
    };
    resolveEndpoint(window.__mepDbCold.completionDetail);
  }

  try {
    ["mark", "element", "longtask"].forEach(function (type) {
      var observer = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          if (entry.entryType === "mark") window.__mepDbCold.marks.push(entry);
          else if (entry.entryType === "element") window.__mepDbCold.elements.push(entry);
          else if (entry.entryType === "longtask") window.__mepDbCold.longTasks.push(entry);
        }
        checkComplete();
      });
      observer.observe({ type: type, buffered: true });
    });
  } catch (err) {
    window.__mepDbCold.observerError = String(err);
    rejectEndpoint(err);
  }
}

// ---------------------------------------------------------------------------
// Expected fixture order (deterministic: newest added first, path tiebreaker)
// ---------------------------------------------------------------------------

function recipeDay(index) {
  return String((index % 28) + 1).padStart(2, "0");
}

function recipePath(index) {
  const number = String(index + 1).padStart(3, "0");
  return `recipes/visual-fixture-${number}.md`;
}

function recipeAdded(index) {
  return `2026-06-${recipeDay(index)}`;
}

function parseAddedTimestamp(index) {
  return Date.parse(`${recipeAdded(index)}T00:00:00Z`);
}

export function expectedRecipeOrder() {
  const indices = Array.from({ length: EXPECTED_COUNT }, (_, i) => i);
  indices.sort((a, b) => {
    const ta = parseAddedTimestamp(a);
    const tb = parseAddedTimestamp(b);
    if (ta !== tb) return tb - ta; // newest first
    return recipePath(a).localeCompare(recipePath(b));
  });
  return indices.map(recipePath);
}

// ---------------------------------------------------------------------------
// Network diagnostics
// ---------------------------------------------------------------------------

function summarizeNetwork(events) {
  const byType = { invoke: [], thumbnail: [], other: [] };
  for (const item of events) {
    const url = item.url;
    if (url.includes("/api/invoke")) byType.invoke.push(item);
    else if (url.includes("/api/thumbnail/")) byType.thumbnail.push(item);
    else byType.other.push(item);
  }

  const bytes = (arr) => arr.reduce((sum, i) => sum + (i.responseBodyBytes || 0), 0);
  const count = (arr) => arr.length;
  const firstStart = (arr) =>
    arr.length === 0 ? null : Math.min(...arr.map((i) => i.startTimeMs));
  const lastEnd = (arr) =>
    arr.length === 0 ? null : Math.max(...arr.map((i) => i.endTimeMs));

  return {
    invoke: {
      count: count(byType.invoke),
      bytes: bytes(byType.invoke),
      firstStartMs: firstStart(byType.invoke),
      lastEndMs: lastEnd(byType.invoke),
    },
    thumbnail: {
      count: count(byType.thumbnail),
      bytes: bytes(byType.thumbnail),
      firstStartMs: firstStart(byType.thumbnail),
      lastEndMs: lastEnd(byType.thumbnail),
    },
    other: {
      count: count(byType.other),
      bytes: bytes(byType.other),
      firstStartMs: firstStart(byType.other),
      lastEndMs: lastEnd(byType.other),
    },
  };
}

// ---------------------------------------------------------------------------
// Element Timing support detection (once, before samples)
// ---------------------------------------------------------------------------

async function checkElementTimingSupport() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const supported = await page.evaluate(() => {
      try {
        var obs = new PerformanceObserver(function () {});
        obs.observe({ entryTypes: ["element"] });
        obs.disconnect();
        return true;
      } catch (e) {
        return false;
      }
    });
    await context.close();
    return supported;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Single sample
// ---------------------------------------------------------------------------

async function runSample({ helper, runIndex, headless }) {
  // 1. Create a fresh fixture (500 PNGs + empty appdata).
  const fixture = await createRecipeScrollFixture();
  const thumbnailCache = await mkdtemp(path.join(tmpdir(), "mep-db-cold-thumb-"));

  // 2. Start an isolated web host + Rust helper.
  const host = await startIsolatedWebHost({ fixture, helper, thumbnailCache });

  // 3. Launch a fresh Chromium browser per sample (cold).
  const browser = await chromium.launch({ headless });

  let context;
  try {
    // 4. Fresh browser context.
    context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: false,
    });

    // 5. Install PerformanceObserver BEFORE any page is created.
    await context.addInitScript(createInitScript());

    // 6. Create page and set up network/error capture.
    const page = await context.newPage();

    const network = [];
    const errors = [];

    page.on("pageerror", (error) => {
      errors.push({ kind: "pageerror", message: errorMessage(error) });
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push({ kind: "console", type: msg.type(), text: msg.text() });
      }
    });
    page.on("response", async (response) => {
      try {
        const request = response.request();
        const timing = request.timing();
        const headers = response.headers();
        const contentLength = headers["content-length"];
        const responseBodyBytes = contentLength ? Number(contentLength) : null;
        let command = null;
        if (request.url().includes("/api/invoke")) {
          try {
            const body = request.postDataJSON();
            command = body?.cmd || null;
          } catch {
            // ignore parse failures
          }
        }
        network.push({
          url: request.url(),
          method: request.method(),
          status: response.status(),
          command,
          startTimeMs: timing ? timing.startTime : 0,
          endTimeMs: timing ? timing.responseEnd : 0,
          responseBodyBytes,
        });
      } catch {
        // ignore network capture failures
      }
    });

    // 7. Navigate to /database.
    await page.goto(host.url, { waitUntil: "commit" });

    // 8. Wait on the promise exposed by the init script (single evaluate, no polling).
    let timedOut = false;
    try {
      await withTimeout(
        page.evaluate(() => window.__mepDbColdEndpoint),
        DEADLINE_MS,
        "endpoint promise"
      );
    } catch {
      timedOut = true;
    }

    // 9. Collect performance data (separate evaluate to serialize entries properly).
    const perf = await page.evaluate(() => {
      var d = window.__mepDbCold || {};
      var toJson = function (entry) {
        return entry && typeof entry.toJSON === "function" ? entry.toJSON() : entry;
      };
      var marks = (d.marks || []).map(function (entry) {
        var json = toJson(entry);
        return Object.assign({}, json, { detail: entry.detail || null });
      });
      var semantic = null;
      for (var m = 0; m < marks.length; m += 1) {
        if (marks[m].name === "mep:database:semantic-ready") {
          semantic = marks[m];
          break;
        }
      }
      return {
        navigation: (function () {
          var entries = performance.getEntriesByType("navigation");
          var e = entries[0];
          if (!e) return null;
          return {
            startTime: e.startTime,
            duration: e.duration,
            domContentLoadedEventStart: e.domContentLoadedEventStart,
            domContentLoadedEventEnd: e.domContentLoadedEventEnd,
            loadEventStart: e.loadEventStart,
            loadEventEnd: e.loadEventEnd,
            domComplete: e.domComplete,
          };
        })(),
        marks: marks,
        elements: (d.elements || []).map(toJson),
        longTasks: (d.longTasks || []).map(toJson),
        observerError: d.observerError || null,
        completionDetail: d.completionDetail || null,
        firstFourPaths: semantic ? (semantic.detail ? semantic.detail.firstFourPaths : null) : null,
      };
    });

    // 10. Extract metrics from collected data.
    const markTime = (name) => {
      const entry = perf.marks.find((m) => m.name === name);
      return entry ? entry.startTime : null;
    };

    const semanticReadyMark = perf.marks.find((m) => m.name === "mep:database:semantic-ready");

    // Element-timing entries, sorted by renderTime.
    const elementTimings = perf.elements
      .filter((e) => typeof e.identifier === "string" && e.identifier.length > 0)
      .map((e) => ({
        identifier: e.identifier,
        renderTime: e.renderTime || 0,
        loadTime: e.loadTime || 0,
        url: e.url || null,
        naturalWidth: e.naturalWidth || 0,
        naturalHeight: e.naturalHeight || 0,
      }))
      .sort((a, b) => a.renderTime - b.renderTime);

    const targetPaths = Array.isArray(perf.firstFourPaths) ? perf.firstFourPaths : [];
    const targetPresentations = targetPaths.map((targetPath) =>
      elementTimings.find((entry) => entry.identifier === targetPath)
    );
    const targetDerivable = targetPaths.length === 4 &&
      new Set(targetPaths).size === 4 &&
      targetPresentations.every((entry) => entry && entry.renderTime > 0);
    const targetRenderTimes = targetDerivable
      ? targetPresentations.map((entry) => entry.renderTime)
      : [];
    const firstCover = targetDerivable
      ? targetPresentations.reduce((earliest, entry) =>
          entry.renderTime < earliest.renderTime ? entry : earliest)
      : null;
    const firstFourEndpoint = targetDerivable ? Math.max(...targetRenderTimes) : null;

    // Diagnostic only: max renderTime across all observed recipe covers.
    const maxRenderTime = elementTimings.length > 0
      ? Math.max(...elementTimings.map((e) => e.renderTime))
      : null;

    // Long task aggregation.
    const longTaskTotalMs = perf.longTasks.reduce((sum, e) => sum + (e.duration || 0), 0);

    // -------------------------------------------------------------------
    // 11. Post-boundary DOM correctness (waitForFunction is OK here --
    //     outside the primary timed window).
    // -------------------------------------------------------------------
    let postDomOk = false;
    try {
      await page.waitForFunction(
        () => {
          var cards = document.querySelectorAll(".cooking-db__card");
          if (cards.length !== 500) return false;
          for (var i = 0; i < cards.length; i += 1) {
            var state = cards[i].getAttribute("data-image-state");
            // Accept "ready" or "error" as terminal; reject "pending" or "none".
            if (state !== "ready") return false;
            var img = cards[i].querySelector("img");
            if (!img) return false;
            if (!img.complete) return false;
            if (img.naturalWidth === 0 || img.naturalHeight === 0) return false;
          }
          return true;
        },
        { timeout: DEADLINE_MS }
      );
      postDomOk = true;
    } catch {
      postDomOk = false;
    }
    const allCoversDecodedMs = await page.evaluate(() => performance.now());
    const resourceNetwork = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => ({
        url: entry.name,
        startTimeMs: entry.startTime,
        endTimeMs: entry.responseEnd,
        responseBodyBytes: entry.transferSize || entry.encodedBodySize || 0,
      }))
    );

    // Collect detailed card data for reporting.
    const cardData = await page.evaluate(() => {
      var cards = document.querySelectorAll(".cooking-db__card");
      return Array.from(cards).map(function (card) {
        var img = card.querySelector("img");
        return {
          path: card.getAttribute("data-path") || "",
          imageState: card.getAttribute("data-image-state") || "",
          naturalWidth: img ? img.naturalWidth : 0,
          naturalHeight: img ? img.naturalHeight : 0,
          complete: img ? img.complete : false,
        };
      });
    });

    const expectedPaths = expectedRecipeOrder();
    const cardPaths = cardData.map((c) => c.path);
    const orderCorrect =
      cardPaths.length === expectedPaths.length &&
      cardPaths.every((p, i) => p === expectedPaths[i]);
    const allCardsPresent = cardData.length === EXPECTED_COUNT;
    const noImageErrors = cardData.every((c) => c.imageState !== "error");
    const allImagesHaveNaturalDimensions = cardData.every(
      (c) => c.naturalWidth > 0 && c.naturalHeight > 0
    );
    const allImagesComplete = cardData.every((c) => c.complete);
    const allReady = cardData.every((c) => c.imageState === "ready");

    const result = {
      run: runIndex,
      timedOut,
      // Mark-based metrics (ms relative to navigation start).
      semanticReadyMs: markTime("mep:database:semantic-ready"),
      allCoversMs: allCoversDecodedMs,
      semanticReadyDetail: semanticReadyMark
        ? (semanticReadyMark.detail || null)
        : null,
      // Element-timing metrics.
      firstCoverMs: firstCover ? firstCover.renderTime : null,
      firstCoverPath: firstCover ? firstCover.identifier : null,
      firstFourCoversMs: firstFourEndpoint,
      firstFourIdentifiers: targetPaths,
      targetDerivable,
      targetRenderTimes,
      maxRenderTimeMs: maxRenderTime,
      coverElementCount: elementTimings.length,
      elementTimings,
      // Long tasks.
      longTaskCount: perf.longTasks.length,
      longTaskTotalMs,
      longTasks: perf.longTasks.map((e) => ({
        duration: e.duration,
        startTime: e.startTime,
        attribution: e.attribution || null,
      })),
      // Network.
      network: summarizeNetwork(resourceNetwork),
      // Errors.
      errors,
      // Post-boundary correctness.
      correctness: {
        cardCount: cardData.length,
        expectedCount: EXPECTED_COUNT,
        allCardsPresent,
        orderCorrect,
        allReady,
        noImageErrors,
        allImagesHaveNaturalDimensions,
        allImagesComplete,
        postDomOk,
        firstMismatchIndex: cardPaths.findIndex((path, index) => path !== expectedPaths[index]),
        firstActualPaths: cardPaths.slice(0, 20),
        firstExpectedPaths: expectedPaths.slice(0, 20),
      },
      observerError: perf.observerError,
      hostOutputTail: host.hostOutputTail(),
      // Raw for debugging.
      perf,
    };

    return result;
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close();
    await host.close();
    await rm(thumbnailCache, { recursive: true, force: true });
    await fixture.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    console.error("Invalid --runs (must be a positive integer)");
    process.exit(1);
  }

  // Build once.
  await buildWebOnce();
  const helper = await findRustHelper();
  log(`Using helper: ${helper}`);

  // Pre-flight: verify Element Timing support.
  const elementTimingSupported = await checkElementTimingSupport();
  if (!elementTimingSupported) {
    log("FATAL: Element Timing (PerformanceObserver entryType 'element') is not supported in this browser.");
    process.exit(1);
  }
  log("Element Timing support confirmed.");

  const samples = [];

  for (let run = 1; run <= args.runs; run += 1) {
    log(`Sample ${run}/${args.runs}...`);
    const sample = await runSample({
      helper,
      runIndex: run,
      headless: args.headless,
    });
    samples.push(sample);
    log(
      `  semanticReady=${sample.semanticReadyMs?.toFixed(1) ?? "n/a"}ms`,
      `firstCover=${sample.firstCoverMs?.toFixed(1) ?? "n/a"}ms`,
      `firstFour=${sample.firstFourCoversMs?.toFixed(1) ?? "n/a"}ms`,
      `maxRenderTime=${sample.maxRenderTimeMs?.toFixed(1) ?? "n/a"}ms`,
      `allCovers=${sample.allCoversMs?.toFixed(1) ?? "n/a"}ms`,
      `timedOut=${sample.timedOut}`,
      `postDomOk=${sample.correctness.postDomOk}`,
      `orderCorrect=${sample.correctness.orderCorrect}`,
      `cards=${sample.correctness.cardCount}/${sample.correctness.expectedCount}`
    );
  }

  // Build summary.
  const semanticReadyValues = samples.map((s) => s.semanticReadyMs).filter((v) => v !== null);
  const firstCoverValues = samples.map((s) => s.firstCoverMs).filter((v) => v !== null);
  const firstFourValues = samples.map((s) => s.firstFourCoversMs).filter((v) => v !== null);
  const maxRenderValues = samples.map((s) => s.maxRenderTimeMs).filter((v) => v !== null);
  const allCoversValues = samples.map((s) => s.allCoversMs).filter((v) => v !== null);
  const longTaskValues = samples.map((s) => s.longTaskTotalMs);

  const summary = {
    workload: {
      recipes: EXPECTED_COUNT,
      raster: "png",
      viewport: VIEWPORT,
      deadlineMs: DEADLINE_MS,
    },
    runs: samples.length,
    elementTimingSupported,
    summary: {
      semanticReadyMs: summarize("semanticReadyMs", semanticReadyValues),
      firstCoverMs: summarize("firstCoverMs", firstCoverValues),
      firstFourCoversMs: summarize("firstFourCoversMs", firstFourValues),
      maxRenderTimeMs: summarize("maxRenderTimeMs", maxRenderValues),
      allCoversMs: summarize("allCoversMs", allCoversValues),
      longTaskTotalMs: summarize("longTaskTotalMs", longTaskValues),
    },
    correctness: samples.map((s) => s.correctness),
    errors: samples.map((s) => s.errors),
    samples,
  };

  const invalidSamples = samples.filter((sample) =>
    sample.timedOut || sample.observerError || !sample.targetDerivable ||
    sample.errors.length > 0 || !sample.correctness.postDomOk ||
    !sample.correctness.orderCorrect || !sample.correctness.allReady ||
    !sample.correctness.noImageErrors ||
    !sample.correctness.allImagesHaveNaturalDimensions
  );
  summary.verdict = invalidSamples.length === 0 ? "VALID" : "INVALID";
  summary.invalidRuns = invalidSamples.map((sample) => sample.run);

  const out = JSON.stringify(summary, null, 2) + "\n";
  console.log(out);
  if (args.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.output, out, "utf8");
    log(`Wrote ${args.output}`);
  }
  if (invalidSamples.length > 0) {
    throw new Error(`invalid cold-load samples: ${invalidSamples.map((sample) => sample.run).join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
