#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { access, readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createRecipeScrollFixture, RECIPE_SCROLL_FIXTURE_COUNT } from "./generate-recipe-scroll-fixture.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_URL = "http://127.0.0.1:4173/";
const DEFAULT_RUNS = 5;
const DEFAULT_SCROLL_MS = 1800;
const DEFAULT_VIEWPORT = { width: 1440, height: 1000 };
const DEFAULT_TARGET_P95_MS = 18;
const DEFAULT_COLD_READINESS_P95_MS = 30000;
const DEFAULT_WARM_READINESS_P95_MS = 5000;
// Time to the first visible cover settling -- the per-card reveal metric. Unlike readinessMs
// (which still waits for the whole fixture, see waitForAllCoversSettled), this is what a real
// user actually experiences: covers appear as their own decode finishes, not on the last one.
const DEFAULT_FIRST_VISIBLE_COVER_P95_MS = 30000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30000;
// Additive real-input scroll profiles for --wheel-scroll. deltaY is the pixel delta per dispatched
// wheel event, tickMs the pause between events; every profile travels the whole scroller and back.
// mode "acked" uses page.mouse.wheel(), which resolves only once the browser has applied the
// scroll -- faithful input path, but it self-throttles to roughly one event per frame and so can
// never outrun the renderer. mode "burst" dispatches Input.dispatchMouseEvent over raw CDP without
// awaiting each acknowledgement, so input queues up regardless of renderer progress: that is the
// condition a real flicked wheel creates.
// Measured 2026-08-05: burst mode locks the page to a 33.4ms (30Hz) frame cadence at every velocity
// tried, from 14k to 60k px/s. A synthetic control page carrying neither content-visibility nor
// images showed the same 33.3-33.4ms cadence under the same gesture, so that number describes
// headless Chromium's frame scheduling under continuous wheel input, not this grid's render cost.
// Read burst results as an input-path control, not as evidence about card rendering.
const WHEEL_SCROLL_PROFILES = [
  { name: "flick", deltaY: 500, tickMs: 8, mode: "acked" },
  { name: "moderate", deltaY: 120, tickMs: 16, mode: "acked" },
  { name: "flick-burst", deltaY: 500, tickMs: 8, mode: "burst" },
  // Same dispatch rate as flick-burst but a fifth of the pixel velocity: it separates the cost of
  // handling wheel events from the cost of pulling new cards through the viewport.
  { name: "moderate-burst", deltaY: 120, tickMs: 8, mode: "burst" }
];
// Chromium animates wheel scrolls on the compositor and a burst gesture keeps draining its input
// queue after the last dispatch, so wait for the scroller to stop moving before reading metrics.
const WHEEL_SETTLE_POLL_MS = 50;
const WHEEL_SETTLE_TIMEOUT_MS = 5000;
// A full-travel moderate wheel gesture over the 500-recipe fixture dispatches thousands of events,
// so it needs its own hang guard rather than the scroll-derived operation timeout.
const WHEEL_PASS_TIMEOUT_MS = 180000;
const ISOLATED_SERVER_TIMEOUT_MS = 60000;
const MAX_HOST_OUTPUT_TAIL_CHARS = 12000;
const THUMBNAIL_VARIANTS = ["v4-320", "v4-640", "other"];

function thumbnailVariant(url) {
  const match = String(url).match(/v4-(320|640)(?=[^0-9]|$)/i);
  return match ? `v4-${match[1]}` : "other";
}

function appendOutputTail(previous, chunk) {
  const next = `${previous}${String(chunk)}`;
  return next.length > MAX_HOST_OUTPUT_TAIL_CHARS
    ? next.slice(-MAX_HOST_OUTPUT_TAIL_CHARS)
    : next;
}

function createStage() {
  return { startedAtMs: performance.now(), startedAtTimestamp: new Date().toISOString(), marks: {} };
}

function markStage(stage, name) {
  if (!stage) return;
  stage.marks[name] = {
    timestamp: new Date().toISOString(),
    performanceMs: performance.now(),
    elapsedMs: Math.round(performance.now() - stage.startedAtMs)
  };
}

function stageSnapshot(stage) {
  return stage ? { startedAtTimestamp: stage.startedAtTimestamp, startedAtPerformanceMs: stage.startedAtMs, marks: stage.marks } : null;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function findRustHelper() {
  const candidates = [
    process.env.MEP_REMOTE_HOST_HELPER,
    "target/debug/mep-remote-host-helper",
    "target/release/mep-remote-host-helper"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard location.
    }
  }
  await execFileAsync("npm", ["run", "build:remote-helper"], { stdio: "inherit" });
  return "target/debug/mep-remote-host-helper";
}

async function startIsolatedWebHost() {
  await execFileAsync("npm", ["run", "build"], { stdio: "inherit" });
  const fixture = await createRecipeScrollFixture();
  const port = await findFreePort();
  const helper = await findRustHelper();
  const { spawn } = await import("node:child_process");
  const child = spawn("node", [
    "scripts/start-web-host.mjs",
    "--vault", fixture.vaultRoot,
    "--appdata", fixture.appDataRoot,
    "--rust-helper", helper,
    "--host", "127.0.0.1",
    "--port", String(port)
  ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const url = `http://127.0.0.1:${port}/`;
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
    await withTimeout(started, ISOLATED_SERVER_TIMEOUT_MS, "isolated web host startup");
  } catch (error) {
    child.kill("SIGTERM");
    await fixture.cleanup();
    if (!error.hostOutputTail) {
      error.hostOutputTail = { stdout: stdoutTail, stderr: stderrTail, combined: combinedTail };
    }
    throw error;
  }
  return {
    url,
    fixture,
    hostOutputTail: () => ({ stdout: stdoutTail, stderr: stderrTail, combined: combinedTail }),
    close: async () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      await fixture.cleanup();
    }
  };
}

async function detectPowerState() {
  const powerState = {
    detected: false,
    onBattery: false,
    onPowersave: false
  };
  if (process.platform !== "linux") return powerState;
  try {
    const supplyEntries = await readdir("/sys/class/power_supply", { withFileTypes: true });
    for (const entry of supplyEntries) {
      try {
        const statusPath = `/sys/class/power_supply/${entry.name}/status`;
        const statusData = await readFile(statusPath, "utf8").catch(() => "");
        const status = statusData.trim();
        if (status === "Discharging") {
          powerState.onBattery = true;
          powerState.detected = true;
        }
      } catch {
        // Silently skip unreadable supply entries
      }
    }
    try {
      const governorPath = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor";
      const governorData = await readFile(governorPath, "utf8").catch(() => "");
      const governor = governorData.trim();
      if (governor === "powersave") {
        powerState.onPowersave = true;
        powerState.detected = true;
      }
    } catch {
      // Silently skip if governor is unreadable
    }
  } catch {
    // Silently return detection failure on non-Linux
  }
  return powerState;
}

function parseArgs(argv) {
  const result = {
    url: process.env.MEP_SCROLL_BENCHMARK_URL || DEFAULT_URL,
    runs: Number(process.env.MEP_SCROLL_BENCHMARK_RUNS || DEFAULT_RUNS),
    scrollMs: Number(process.env.MEP_SCROLL_BENCHMARK_SCROLL_MS || DEFAULT_SCROLL_MS),
    targetP95Ms: Number(process.env.MEP_SCROLL_BENCHMARK_TARGET_P95_MS || DEFAULT_TARGET_P95_MS),
    coldReadinessP95Ms: Number(process.env.MEP_SCROLL_BENCHMARK_COLD_READINESS_P95_MS || DEFAULT_COLD_READINESS_P95_MS),
    warmReadinessP95Ms: Number(process.env.MEP_SCROLL_BENCHMARK_WARM_READINESS_P95_MS || DEFAULT_WARM_READINESS_P95_MS),
    firstVisibleCoverP95Ms: Number(process.env.MEP_SCROLL_BENCHMARK_FIRST_VISIBLE_COVER_P95_MS || DEFAULT_FIRST_VISIBLE_COVER_P95_MS),
    output: process.env.MEP_SCROLL_BENCHMARK_OUTPUT || "",
    headless: process.env.MEP_SCROLL_BENCHMARK_HEADLESS !== "0",
    allowBattery: process.env.MEP_BENCHMARK_ALLOW_BATTERY === "1",
    wheelScroll: process.env.MEP_SCROLL_BENCHMARK_WHEEL === "1"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--headed") {
      result.headless = false;
      continue;
    }
    if (token === "--wheel-scroll") {
      result.wheelScroll = true;
      continue;
    }
    if (token === "--allow-battery") {
      result.allowBattery = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = {
      "cold-readiness-p95-ms": "coldReadinessP95Ms",
      "warm-readiness-p95-ms": "warmReadinessP95Ms",
      "first-visible-cover-p95-ms": "firstVisibleCoverP95Ms"
    }[token.slice(2)] ?? token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  result.runs = DEFAULT_RUNS;
  result.scrollMs = Math.max(400, Number(result.scrollMs) || DEFAULT_SCROLL_MS);
  result.targetP95Ms = Math.max(1, Number(result.targetP95Ms) || DEFAULT_TARGET_P95_MS);
  result.coldReadinessP95Ms = Math.max(1, Number(result.coldReadinessP95Ms) || DEFAULT_COLD_READINESS_P95_MS);
  result.warmReadinessP95Ms = Math.max(1, Number(result.warmReadinessP95Ms) || DEFAULT_WARM_READINESS_P95_MS);
  result.firstVisibleCoverP95Ms = Math.max(1, Number(result.firstVisibleCoverP95Ms) || DEFAULT_FIRST_VISIBLE_COVER_P95_MS);
  return result;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  return percentile(values, 50);
}

function summarize(values) {
  return { min: Math.min(...values), median: median(values), p95: percentile(values, 95), max: Math.max(...values) };
}

function serializeTransport(transport) {
  return {
    requests: transport.requests,
    responses: transport.responses,
    failedResponses: transport.failedResponses,
    transferredBytes: transport.transferredBytes,
    uniqueImages: transport.uniqueImages,
    variants: transport.variants,
    timing: transport.timing
  };
}

function serializeScrollMetric(scroll) {
  return {
    frameP95Ms: percentile(scroll.frameGaps, 95),
    frameMaxMs: Math.max(...scroll.frameGaps),
    longFrames: scroll.longFrames,
    severeFrames: scroll.severeFrames,
    minVisibleCards: scroll.minVisibleCards,
    maxEmptyCovers: scroll.maxEmptyCovers,
    maxBlankCovers: scroll.maxBlankCovers,
    maxErrorCovers: scroll.maxErrorCovers,
    maxIncompleteImages: scroll.maxIncompleteImages,
    maxSyntheticImages: scroll.maxSyntheticImages,
    transport: serializeTransport(scroll.transport)
  };
}

function serializeWheelScrollMetric(wheel) {
  return {
    profile: wheel.profile,
    gesture: wheel.gesture,
    frameP95Ms: percentile(wheel.frameGaps, 95),
    frameMaxMs: Math.max(...wheel.frameGaps),
    frameSampleCount: wheel.frameGaps.length,
    longFrames: wheel.longFrames,
    severeFrames: wheel.severeFrames,
    minRenderedCards: wheel.minRenderedCards,
    minVisibleCards: wheel.minVisibleCards,
    maxEmptyCovers: wheel.maxEmptyCovers,
    maxBlankCovers: wheel.maxBlankCovers,
    maxErrorCovers: wheel.maxErrorCovers,
    maxIncompleteImages: wheel.maxIncompleteImages,
    maxSyntheticImages: wheel.maxSyntheticImages,
    maxScroll: wheel.maxScroll,
    maxObservedScrollTop: wheel.maxObservedScrollTop,
    endScrollTop: wheel.endScrollTop,
    transport: serializeTransport(wheel.transport)
  };
}

function summarizeWheelProfile(runs, profileName) {
  const passes = runs
    .map((run) => (run.wheelScroll ?? []).find((entry) => entry.profile.name === profileName))
    .filter(Boolean);
  if (passes.length === 0) return null;
  return {
    profile: passes[0].profile,
    passes: passes.length,
    frameP95Ms: summarize(passes.map((pass) => percentile(pass.frameGaps, 95))),
    frameMaxMs: summarize(passes.map((pass) => Math.max(...pass.frameGaps))),
    totalLongFrames: passes.reduce((sum, pass) => sum + pass.longFrames, 0),
    totalSevereFrames: passes.reduce((sum, pass) => sum + pass.severeFrames, 0),
    minRenderedCards: Math.min(...passes.map((pass) => pass.minRenderedCards)),
    minVisibleCards: Math.min(...passes.map((pass) => pass.minVisibleCards)),
    maxEmptyCovers: Math.max(...passes.map((pass) => pass.maxEmptyCovers)),
    maxBlankCovers: Math.max(...passes.map((pass) => pass.maxBlankCovers)),
    maxErrorCovers: Math.max(...passes.map((pass) => pass.maxErrorCovers)),
    maxIncompleteImages: Math.max(...passes.map((pass) => pass.maxIncompleteImages)),
    maxSyntheticImages: Math.max(...passes.map((pass) => pass.maxSyntheticImages)),
    gesture: {
      eventsPerSecond: summarize(passes.map((pass) => pass.gesture.eventsPerSecond)),
      requestedPixelsPerSecond: summarize(passes.map((pass) => pass.gesture.requestedPixelsPerSecond)),
      gestureMs: summarize(passes.map((pass) => pass.gesture.gestureMs)),
      wheelEvents: summarize(passes.map((pass) => pass.gesture.wheelEvents)),
      settledPasses: passes.filter((pass) => pass.gesture.settled).length,
      settleMs: summarize(passes.map((pass) => pass.gesture.settleMs)),
      reachedBottomPasses: passes.filter((pass) => pass.gesture.reachedBottom).length,
      returnedToTopPasses: passes.filter((pass) => pass.gesture.returnedToTop).length
    },
    travel: {
      maxScroll: summarize(passes.map((pass) => pass.maxScroll)),
      maxObservedScrollTop: summarize(passes.map((pass) => pass.maxObservedScrollTop))
    },
    transport: {
      responses: summarize(passes.map((pass) => pass.transport.responses)),
      transferredBytes: summarize(passes.map((pass) => pass.transport.transferredBytes)),
      uniqueImages: summarize(passes.map((pass) => pass.transport.uniqueImages))
    }
  };
}

function summarizeProgrammaticScrolls(scrolls) {
  return {
    passes: scrolls.length,
    frameP95Ms: summarize(scrolls.map((scroll) => percentile(scroll.frameGaps, 95))),
    frameMaxMs: summarize(scrolls.map((scroll) => Math.max(...scroll.frameGaps))),
    totalLongFrames: scrolls.reduce((sum, scroll) => sum + scroll.longFrames, 0),
    totalSevereFrames: scrolls.reduce((sum, scroll) => sum + scroll.severeFrames, 0),
    maxBlankCovers: Math.max(...scrolls.map((scroll) => scroll.maxBlankCovers)),
    maxIncompleteImages: Math.max(...scrolls.map((scroll) => scroll.maxIncompleteImages)),
    minVisibleCards: Math.min(...scrolls.map((scroll) => scroll.minVisibleCards))
  };
}

function printScrollInputComparison(rows) {
  const columns = [
    { key: "pass", label: "pass", width: 26 },
    { key: "frameP95Median", label: "frameP95 med", width: 13 },
    { key: "frameP95Max", label: "frameP95 max", width: 13 },
    { key: "frameMax", label: "frameMax", width: 10 },
    { key: "longFrames", label: "long>24ms", width: 10 },
    { key: "severeFrames", label: "severe>50ms", width: 12 },
    { key: "maxBlankCovers", label: "maxBlank", width: 9 },
    { key: "maxIncompleteImages", label: "maxIncomplete", width: 13 }
  ];
  const line = (values) => columns.map((column) => String(values[column.key]).padEnd(column.width)).join(" ");
  console.log("");
  console.log("scroll input-path comparison (warm phase; programmatic drives scrollTop, wheel dispatches real wheel events)");
  console.log(line(Object.fromEntries(columns.map((column) => [column.key, column.label]))));
  for (const row of rows) console.log(line(row));
  console.log("");
}

function serializeRunMetric(run, runNumber) {
  return {
    run: runNumber,
    environment: run.environment,
    phaseTimestamps: run.phaseTimestamps,
    performanceEvidence: run.performanceEvidence,
    cold: {
      readinessMs: run.cold.readinessMs,
      firstVisibleCoverMs: run.cold.firstVisibleCoverMs,
      readinessTransport: serializeTransport(run.cold.readinessTransport),
      scroll: serializeScrollMetric(run.cold.scroll)
    },
    warm: {
      readinessMs: run.warm.readinessMs,
      firstVisibleCoverMs: run.warm.firstVisibleCoverMs,
      readinessTransport: serializeTransport(run.warm.readinessTransport),
      scroll: serializeScrollMetric(run.warm.scroll)
    },
    wheelScroll: (run.wheelScroll ?? []).map(serializeWheelScrollMetric)
  };
}

function hostEnvironment() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.availableParallelism?.() ?? os.cpus().length,
    processId: process.pid
  };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function evaluatePhaseMetric(failures, phase, metric, threshold) {
  if (!metric || !finiteNumber(metric.readinessMs)) {
    failures.push(`${phase} readiness metric missing or invalid`);
  } else if (metric.readinessMs > threshold) {
    failures.push(`${phase} readiness ${metric.readinessMs}ms > ${threshold}ms`);
  }
  if (!metric || !finiteNumber(metric.firstVisibleCoverMs)) {
    failures.push(`${phase} first-visible-cover metric missing or invalid`);
  } else if (metric.firstVisibleCoverMs > DEFAULT_FIRST_VISIBLE_COVER_P95_MS) {
    failures.push(`${phase} first-visible-cover ${metric.firstVisibleCoverMs}ms > ${DEFAULT_FIRST_VISIBLE_COVER_P95_MS}ms`);
  } else if (finiteNumber(metric.readinessMs) && metric.firstVisibleCoverMs > metric.readinessMs) {
    failures.push(`${phase} first-visible-cover ${metric.firstVisibleCoverMs}ms > readiness ${metric.readinessMs}ms (visible cards must settle no later than the whole fixture)`);
  }
  const readinessTransport = metric?.readinessTransport;
  if (!readinessTransport || !finiteNumber(readinessTransport.responses) || !finiteNumber(readinessTransport.transferredBytes) || !finiteNumber(readinessTransport.uniqueImages)) {
    failures.push(`${phase} readiness transport metric missing or invalid`);
  } else if (readinessTransport.failedResponses !== 0 || readinessTransport.variants?.["v4-320"]?.requests !== RECIPE_SCROLL_FIXTURE_COUNT || readinessTransport.variants?.["v4-320"]?.responses !== RECIPE_SCROLL_FIXTURE_COUNT || readinessTransport.variants?.["v4-320"]?.uniqueImages !== RECIPE_SCROLL_FIXTURE_COUNT) {
    const cardVariant = readinessTransport.variants?.["v4-320"];
    failures.push(`${phase} readiness card transport ${cardVariant?.requests}/${cardVariant?.responses}/${cardVariant?.uniqueImages} does not equal ${RECIPE_SCROLL_FIXTURE_COUNT} unique requests`);
  } else if (!readinessTransport.variants?.["v4-320"] || !readinessTransport.variants?.["v4-640"] || !readinessTransport.timing || !finiteNumber(readinessTransport.timing.responseCountWithTiming) || !finiteNumber(readinessTransport.timing.duplicateRequestCount)) {
    failures.push(`${phase} readiness transport timing/variant evidence missing`);
  } else if (readinessTransport.timing.duplicateRequestCount !== 0) {
    failures.push(`${phase} readiness duplicate requests ${readinessTransport.timing.duplicateRequestCount} > 0`);
  } else {
    const invokeEvents = readinessTransport.timing.invokeEvents ?? [];
    for (const [command, expectedCount] of [
      ["mep_recipe_database_stream", 1],
      ["mep_prepare_database_thumbnails", 2]
    ]) {
      const count = invokeEvents.filter((event) => event.command === command).length;
      if (count !== expectedCount) failures.push(`${phase} ${command} count ${count} !== ${expectedCount}`);
    }
  }
  const scroll = metric?.scroll;
  if (!scroll) {
    failures.push(`${phase} scroll metric missing`);
    return;
  }
  if (!finiteNumber(scroll.frameP95Ms)) failures.push(`${phase} frame p95 metric missing or invalid`);
  else if (scroll.frameP95Ms > DEFAULT_TARGET_P95_MS) failures.push(`${phase} frame p95 ${scroll.frameP95Ms}ms > ${DEFAULT_TARGET_P95_MS}ms`);
  if (!finiteNumber(scroll.frameMaxMs)) failures.push(`${phase} frame max metric missing or invalid`);
  if (scroll.severeFrames !== 0) failures.push(`${phase} severe frames ${scroll.severeFrames} > 0`);
  for (const [name, value] of [
    ["maxEmptyCovers", scroll.maxEmptyCovers],
    ["maxBlankCovers", scroll.maxBlankCovers],
    ["maxErrorCovers", scroll.maxErrorCovers],
    ["maxIncompleteImages", scroll.maxIncompleteImages],
    ["maxSyntheticImages", scroll.maxSyntheticImages]
  ]) {
    if (value !== 0) failures.push(`${phase} ${name} ${value} > 0`);
  }
  const transport = scroll.transport;
  if (!transport) {
    failures.push(`${phase} scroll transport missing`);
    return;
  }
  if (transport.failedResponses !== 0 || transport.responses !== 0 || transport.transferredBytes !== 0 || transport.uniqueImages !== 0) {
    failures.push(`${phase} scroll image responses/bytes/unique ${transport.responses}/${transport.transferredBytes}/${transport.uniqueImages} > 0`);
  }
  if (!transport.timing || !finiteNumber(transport.timing.responseCountWithTiming) || !finiteNumber(transport.timing.duplicateRequestCount)) {
    failures.push(`${phase} scroll transport timing evidence missing`);
  }
}

export function evaluateScrollArtifact(summary) {
  const failures = [];
  if (!summary || typeof summary !== "object") return ["artifact summary missing"];
  if (summary.runs !== DEFAULT_RUNS) failures.push(`runs ${summary.runs} !== ${DEFAULT_RUNS}`);
  if (summary.completedRuns !== DEFAULT_RUNS) failures.push(`completedRuns ${summary.completedRuns} !== ${DEFAULT_RUNS}`);
  if (summary.workload?.recipes !== RECIPE_SCROLL_FIXTURE_COUNT) failures.push(`workload recipes ${summary.workload?.recipes} !== ${RECIPE_SCROLL_FIXTURE_COUNT}`);
  if (summary.workload?.raster !== "png" || JSON.stringify(summary.workload?.phases) !== JSON.stringify(["cold", "warm"])) failures.push("workload raster/phases do not match the fixed scroll contract");
  const thresholds = summary.thresholds;
  if (thresholds?.frameP95Ms !== DEFAULT_TARGET_P95_MS) failures.push(`frame threshold ${thresholds?.frameP95Ms} !== ${DEFAULT_TARGET_P95_MS}`);
  if (thresholds?.coldReadinessP95Ms !== DEFAULT_COLD_READINESS_P95_MS) failures.push(`cold readiness threshold ${thresholds?.coldReadinessP95Ms} !== ${DEFAULT_COLD_READINESS_P95_MS}`);
  if (thresholds?.warmReadinessP95Ms !== DEFAULT_WARM_READINESS_P95_MS) failures.push(`warm readiness threshold ${thresholds?.warmReadinessP95Ms} !== ${DEFAULT_WARM_READINESS_P95_MS}`);
  if (thresholds?.firstVisibleCoverP95Ms !== DEFAULT_FIRST_VISIBLE_COVER_P95_MS) failures.push(`first-visible-cover threshold ${thresholds?.firstVisibleCoverP95Ms} !== ${DEFAULT_FIRST_VISIBLE_COVER_P95_MS}`);
  if (thresholds?.scrollImageResponses !== 0) failures.push(`scroll image response threshold ${thresholds?.scrollImageResponses} !== 0`);
  if (thresholds?.scrollImageBytes !== 0) failures.push(`scroll image byte threshold ${thresholds?.scrollImageBytes} !== 0`);
  if (!validTimestamp(summary.artifactGeneratedAt)) failures.push("artifact timestamp missing or invalid");
  if (!/^[0-9a-f]{40}$/i.test(summary.buildIdentity?.gitHead ?? "") || !/^[0-9a-f]{64}$/i.test(summary.buildIdentity?.benchmarkScriptSha256 ?? "") || !/^[0-9a-f]{64}$/i.test(summary.buildIdentity?.worktreeStatusSha256 ?? "")) {
    failures.push("build identity missing reproducible git/worktree fingerprints");
  }
  if (!Array.isArray(summary.runMetrics) || summary.runMetrics.length !== DEFAULT_RUNS) {
    failures.push(`runMetrics length ${summary.runMetrics?.length ?? "missing"} !== ${DEFAULT_RUNS}`);
  } else {
    summary.runMetrics.forEach((run, index) => {
      if (run?.run !== index + 1) failures.push(`runMetrics[${index}] run number is ${run?.run}`);
      if (!run?.environment?.nodeVersion || !run.environment.platform || !run.environment.arch || !finiteNumber(run.environment.cpuCount) || !run.environment.browserUserAgent) {
        failures.push(`runMetrics[${index}] environment provenance missing`);
      }
      for (const phase of ["cold", "warm"]) {
        const marks = run?.phaseTimestamps?.[phase]?.marks;
        if (!marks?.navigationStarted || !marks?.databaseCountReady || !marks?.gridReady || !marks?.scrollStarted || !marks?.scrollCompleted) {
          failures.push(`runMetrics[${index}] ${phase} phase timestamps incomplete`);
        }
        const evidence = run?.performanceEvidence?.[phase];
        if (!evidence?.readiness || !evidence?.scroll || !finiteNumber(evidence.readiness.longTaskCount) || !finiteNumber(evidence.scroll.longTaskCount)) {
          failures.push(`runMetrics[${index}] ${phase} long-task evidence incomplete`);
        }
      }
      evaluatePhaseMetric(failures, `run ${index + 1} cold`, run?.cold, DEFAULT_COLD_READINESS_P95_MS);
      evaluatePhaseMetric(failures, `run ${index + 1} warm`, run?.warm, DEFAULT_WARM_READINESS_P95_MS);
    });
  }
  if (!finiteNumber(summary.p95FrameGap?.p95)) failures.push("aggregate frame p95 metric missing or invalid");
  else if (summary.p95FrameGap.p95 > DEFAULT_TARGET_P95_MS) failures.push(`aggregate frame p95 ${summary.p95FrameGap.p95}ms > ${DEFAULT_TARGET_P95_MS}ms`);
  if (summary.totalSevereFrames !== 0) failures.push(`aggregate severe frames ${summary.totalSevereFrames} > 0`);
  if (!finiteNumber(summary.readinessMs?.cold?.p95)) failures.push("aggregate cold readiness p95 metric missing or invalid");
  else if (summary.readinessMs.cold.p95 > DEFAULT_COLD_READINESS_P95_MS) failures.push(`aggregate cold readiness p95 ${summary.readinessMs.cold.p95}ms > ${DEFAULT_COLD_READINESS_P95_MS}ms`);
  if (!finiteNumber(summary.readinessMs?.warm?.p95)) failures.push("aggregate warm readiness p95 metric missing or invalid");
  else if (summary.readinessMs.warm.p95 > DEFAULT_WARM_READINESS_P95_MS) failures.push(`aggregate warm readiness p95 ${summary.readinessMs.warm.p95}ms > ${DEFAULT_WARM_READINESS_P95_MS}ms`);
  if (!finiteNumber(summary.firstVisibleCoverMs?.cold?.p95)) failures.push("aggregate cold first-visible-cover p95 metric missing or invalid");
  else if (summary.firstVisibleCoverMs.cold.p95 > DEFAULT_FIRST_VISIBLE_COVER_P95_MS) failures.push(`aggregate cold first-visible-cover p95 ${summary.firstVisibleCoverMs.cold.p95}ms > ${DEFAULT_FIRST_VISIBLE_COVER_P95_MS}ms`);
  if (!finiteNumber(summary.firstVisibleCoverMs?.warm?.p95)) failures.push("aggregate warm first-visible-cover p95 metric missing or invalid");
  else if (summary.firstVisibleCoverMs.warm.p95 > DEFAULT_FIRST_VISIBLE_COVER_P95_MS) failures.push(`aggregate warm first-visible-cover p95 ${summary.firstVisibleCoverMs.warm.p95}ms > ${DEFAULT_FIRST_VISIBLE_COVER_P95_MS}ms`);
  for (const [name, value] of [
    ["maxEmptyCovers", summary.maxEmptyCovers],
    ["maxBlankCovers", summary.maxBlankCovers],
    ["maxErrorCovers", summary.maxErrorCovers],
    ["maxIncompleteImages", summary.maxIncompleteImages],
    ["maxSyntheticImages", summary.maxSyntheticImages]
  ]) {
    if (value !== 0) failures.push(`aggregate ${name} ${value} > 0`);
  }
  for (const [name, value] of [
    ["coldScrollResponses", summary.imageTransport?.coldScrollResponses?.max],
    ["warmScrollResponses", summary.imageTransport?.warmScrollResponses?.max],
    ["coldScrollBytes", summary.imageTransport?.coldScrollBytes?.max],
    ["warmScrollBytes", summary.imageTransport?.warmScrollBytes?.max],
    ["coldScrollUniqueImages", summary.imageTransport?.coldScrollUniqueImages?.max],
    ["warmScrollUniqueImages", summary.imageTransport?.warmScrollUniqueImages?.max]
  ]) {
    if (value !== 0) failures.push(`aggregate ${name} ${value} > 0`);
  }
  if (summary.consoleDiagnostics?.length > 0) failures.push(`${summary.consoleDiagnostics.length} console diagnostics`);
  if (summary.failedRequests?.length > 0) failures.push(`${summary.failedRequests.length} failed requests`);
  return failures;
}

async function getArtifactIdentity() {
  const [headResult, statusResult, scriptBytes] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"]),
    execFileAsync("git", ["status", "--porcelain=v1"]),
    readFile(new URL("./benchmark-recipe-scroll.mjs", import.meta.url))
  ]);
  const worktreeStatus = statusResult.stdout.trim();
  return {
    generatedAt: new Date().toISOString(),
    gitHead: headResult.stdout.trim(),
    worktreeDirty: worktreeStatus.length > 0,
    worktreeStatusSha256: createHash("sha256").update(worktreeStatus).digest("hex"),
    benchmarkScriptSha256: createHash("sha256").update(scriptBytes).digest("hex")
  };
}

function summarizeVariantTransport(runs, getTransport) {
  return Object.fromEntries(THUMBNAIL_VARIANTS.map((variant) => [variant, {
    requests: summarize(runs.map((run) => getTransport(run).variants?.[variant]?.requests ?? 0)),
    responses: summarize(runs.map((run) => getTransport(run).variants?.[variant]?.responses ?? 0)),
    transferredBytes: summarize(runs.map((run) => getTransport(run).variants?.[variant]?.transferredBytes ?? 0)),
    uniqueImages: summarize(runs.map((run) => getTransport(run).variants?.[variant]?.uniqueImages ?? 0))
  }]));
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

function createTransportCapture(page) {
  let active = null;
  const timingSnapshot = (capture) => {
    const requests = capture.requestEvents;
    const responses = capture.responses.filter((response) => Number.isFinite(response.requestStartedAtMs) && Number.isFinite(response.responseReceivedAtMs));
    const intervalsOverlap = (left, right) => left.requestStartedAtMs < right.responseReceivedAtMs && right.requestStartedAtMs < left.responseReceivedAtMs;
    const detailResponses = responses.filter((response) => response.variant === "v4-640");
    const cardResponses = responses.filter((response) => response.variant === "v4-320");
    const detailOverlappingCardCount = detailResponses.filter((detail) => cardResponses.some((card) => intervalsOverlap(detail, card))).length;
    const requestsByUrl = new Map();
    for (const request of requests) {
      const entries = requestsByUrl.get(request.url) ?? [];
      entries.push(request);
      requestsByUrl.set(request.url, entries);
    }
    const duplicateUrlGroups = [...requestsByUrl.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([url, entries]) => ({
        url,
        count: entries.length,
        firstRequestAtMs: Math.min(...entries.map((entry) => entry.startedAtMs)),
        lastRequestAtMs: Math.max(...entries.map((entry) => entry.startedAtMs)),
        variant: entries[0].variant
      }))
      .sort((left, right) => right.count - left.count || left.url.localeCompare(right.url));
    const variantTiming = Object.fromEntries(THUMBNAIL_VARIANTS.map((variant) => {
      const variantResponses = responses.filter((response) => response.variant === variant);
      return [variant, {
        requestCount: requests.filter((request) => request.variant === variant).length,
        responseCount: variantResponses.length,
        firstRequestAtMs: Math.min(...requests.filter((request) => request.variant === variant).map((request) => request.startedAtMs), Infinity),
        lastResponseAtMs: Math.max(...variantResponses.map((response) => response.responseReceivedAtMs), -Infinity)
      }];
    }));
    return {
      firstRequestAtMs: Math.min(...requests.map((request) => request.startedAtMs), Infinity),
      lastResponseAtMs: Math.max(...responses.map((response) => response.responseReceivedAtMs), -Infinity),
      firstRequestOffsetMs: Number.isFinite(capture.stageStartedAtMs) && requests.length > 0 ? Math.min(...requests.map((request) => request.startedAtMs)) - capture.stageStartedAtMs : null,
      lastResponseOffsetMs: Number.isFinite(capture.stageStartedAtMs) && responses.length > 0 ? Math.max(...responses.map((response) => response.responseReceivedAtMs)) - capture.stageStartedAtMs : null,
      responseCountWithTiming: responses.length,
      detailOverlappingCardCount,
      duplicateRequestCount: duplicateUrlGroups.reduce((sum, group) => sum + group.count - 1, 0),
      duplicateUrlGroups,
      invokeEvents: capture.invokeEvents.map((event) => ({
        command: event.command,
        status: event.status,
        startedAtOffsetMs: Number.isFinite(capture.stageStartedAtMs) ? event.startedAtMs - capture.stageStartedAtMs : null,
        responseAtOffsetMs: Number.isFinite(capture.stageStartedAtMs) && Number.isFinite(event.responseAtMs) ? event.responseAtMs - capture.stageStartedAtMs : null,
        durationMs: Number.isFinite(event.responseAtMs) ? event.responseAtMs - event.startedAtMs : null
      })),
      variants: variantTiming
    };
  };
  const variantSnapshot = (capture) => Object.fromEntries(THUMBNAIL_VARIANTS.map((variant) => {
    const responses = capture.responses.filter((response) => response.variant === variant);
    const successful = responses.filter((response) => response.status >= 200 && response.status < 300);
    return [variant, {
      requests: capture.variantRequests[variant] ?? 0,
      responses: successful.length,
      transferredBytes: successful.reduce((sum, response) => sum + response.bytes, 0),
      uniqueImages: new Set(successful.map((response) => response.url)).size
    }];
  }));
  const snapshot = (capture) => {
    if (!capture) return null;
    const statusCounts = {};
    for (const response of capture.responses) {
      const key = String(response.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    }
    return {
      requests: capture.requests,
      responses: capture.responses.length,
      pendingResponses: capture.pendingCount,
      responseStatusCounts: statusCounts,
      transferredBytes: capture.responses.reduce((sum, response) => sum + response.bytes, 0),
      uniqueImages: new Set(capture.responses.map((response) => response.url)).size,
      variants: variantSnapshot(capture),
      timing: timingSnapshot(capture)
    };
  };
  page.on("request", (request) => {
    if (!active || !request.url().includes("/api/thumbnail")) return;
    active.requests += 1;
    const variant = thumbnailVariant(request.url());
    active.variantRequests[variant] = (active.variantRequests[variant] ?? 0) + 1;
    const event = { url: request.url(), variant, startedAtMs: performance.now() };
    active.requestEvents.push(event);
    const pending = active.pendingRequestsByUrl.get(event.url) ?? [];
    pending.push(event);
    active.pendingRequestsByUrl.set(event.url, pending);
  });
  page.on("response", (response) => {
    if (!active || !response.url().includes("/api/thumbnail")) return;
    const capture = active;
    const pending = capture.pendingRequestsByUrl.get(response.url()) ?? [];
    const requestEvent = pending.shift();
    if (pending.length === 0) capture.pendingRequestsByUrl.delete(response.url());
    const item = { url: response.url(), status: response.status(), bytes: 0, variant: thumbnailVariant(response.url()), requestStartedAtMs: requestEvent?.startedAtMs ?? null, responseReceivedAtMs: performance.now() };
    capture.responses.push(item);
    capture.pendingCount += 1;
    capture.pending.push(response.body().then((body) => {
      item.bytes = body.byteLength;
    }).catch(() => {}).finally(() => {
      capture.pendingCount = Math.max(0, capture.pendingCount - 1);
    }));
  });
  page.on("request", (request) => {
    if (!active || !request.url().includes("/api/invoke")) return;
    let command = "unknown";
    try {
      command = JSON.parse(request.postData() ?? "{}").cmd ?? command;
    } catch {
      // Keep malformed invoke payloads visible without failing the benchmark.
    }
    const event = { command, startedAtMs: performance.now(), status: null, responseAtMs: null };
    active.invokeEvents.push(event);
    active.invokeByRequest.set(request, event);
  });
  page.on("response", (response) => {
    if (!active || !response.url().includes("/api/invoke")) return;
    const event = active.invokeByRequest.get(response.request());
    if (!event) return;
    event.status = response.status();
    event.responseAtMs = performance.now();
  });
  return {
    start(stageStartedAtMs = performance.now()) {
      active = { requests: 0, responses: [], pending: [], pendingCount: 0, variantRequests: {}, requestEvents: [], pendingRequestsByUrl: new Map(), invokeEvents: [], invokeByRequest: new Map(), stageStartedAtMs };
      return active;
    },
    async stop(capture) {
      await Promise.all(capture.pending);
      if (active === capture) active = null;
      const successful = capture.responses.filter((response) => response.status >= 200 && response.status < 300);
      return {
        requests: capture.requests,
        responses: successful.length,
        failedResponses: capture.responses.length - successful.length,
        transferredBytes: successful.reduce((sum, response) => sum + response.bytes, 0),
        uniqueImages: new Set(successful.map((response) => response.url)).size,
        variants: variantSnapshot(capture),
        timing: timingSnapshot(capture)
      };
    },
    snapshot() {
      return snapshot(active);
    }
  };
}

export function isExpectedWatchAbort(requestUrl, failure) {
  if (failure !== "net::ERR_ABORTED") return false;
  try {
    return new URL(requestUrl).pathname === "/api/watch";
  } catch {
    return false;
  }
}

function installDiagnostics(page) {
  const consoleDiagnostics = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if ((message.type() === "error" || message.type() === "warning") && !message.text().includes("ResizeObserver loop")) {
      consoleDiagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => consoleDiagnostics.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    if (request.url().includes("/api/fs/stat") && failure === "net::ERR_ABORTED") return;
    if (isExpectedWatchAbort(request.url(), failure)) return;
    if (!request.url().includes("favicon")) failedRequests.push(`${request.url()}: ${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("favicon")) {
      const body = response.request().postData();
      failedRequests.push(`${response.url()}: HTTP ${response.status()}${body ? ` body=${body}` : ""}`);
    }
  });
  return { consoleDiagnostics, failedRequests };
}

async function installPerformanceEvidence(page) {
  await page.evaluate(() => {
    const supported = typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask");
    const state = { supported: Boolean(supported), entries: [] };
    if (supported) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.entries.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      state.observer = observer;
    }
    globalThis.__MEP_PERFORMANCE_EVIDENCE__ = state;
  });
}

async function collectPerformanceEvidence(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const browserEvidence = await page.evaluate(() => {
    const state = globalThis.__MEP_PERFORMANCE_EVIDENCE__;
    const memory = performance.memory
      ? { jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, totalJSHeapSize: performance.memory.totalJSHeapSize, usedJSHeapSize: performance.memory.usedJSHeapSize }
      : null;
    if (!state) return { longTaskSupported: false, longTaskCount: 0, longTasks: [], memory };
    const longTasks = state.entries.splice(0, state.entries.length);
    return { longTaskSupported: state.supported, longTaskCount: longTasks.length, longTasks, memory };
  });
  const usage = process.resourceUsage();
  return {
    ...browserEvidence,
    host: {
      userCPUTimeMs: usage.userCPUTime / 1000,
      systemCPUTimeMs: usage.systemCPUTime / 1000,
      maxRSSKb: usage.maxRSS,
      fsRead: usage.fsRead,
      fsWrite: usage.fsWrite
    }
  };
}

async function collectDomState(page) {
  if (!page) return null;
  return page.evaluate(() => {
    const text = (selector) => Array.from(document.querySelectorAll(selector))
      .map((element) => element.textContent?.trim())
      .filter(Boolean)
      .slice(0, 10);
    return {
      databaseCountText: document.querySelector(".cooking-db__count")?.textContent?.trim() ?? null,
      cardCount: document.querySelectorAll(".cooking-db__card").length,
      loadingText: text('[aria-busy="true"], .mep-loading, .loading, .loading-indicator')
    };
  });
}

async function findScrollElement(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".cooking-db__grid-container");
    const firstCard = document.querySelector(".cooking-db__card");
    const candidates = [];
    if (root) candidates.push(root, ...Array.from(root.querySelectorAll("*")));
    for (let element = firstCard?.parentElement; element; element = element.parentElement) candidates.push(element);
    const scrollable = candidates.find((element) => {
      const style = window.getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 40 && style.overflowY !== "visible" && style.overflowY !== "hidden";
    });
    if (!scrollable) throw new Error("Missing scrollable recipe grid element.");
    return true;
  });
}

async function waitForRecipeDatabase(page, url, { load = true, stage = null } = {}) {
  markStage(stage, "navigationStarted");
  if (load) await page.goto(url, { waitUntil: "domcontentloaded" });
  markStage(stage, "navigationCompleted");
  await page.waitForFunction(() => Boolean(globalThis.__MEP_REMOTE_HOST__) || globalThis.__MEP_SHIM_FIXTURE_ID__ === "visual-v1", undefined, { timeout: 10000 });
  const sidebarToggle = page.locator(".mep-sidebar__toggle");
  const captureButton = page.locator('button:has-text("Capture recipe")');
  if (!(await captureButton.isVisible()) && (await sidebarToggle.isVisible())) await sidebarToggle.click();
  await page.click('button.mep-nav__item:has-text("Recipe Database")');
  await page.waitForSelector(".cooking-db__card", { state: "visible", timeout: 30000 });
  markStage(stage, "cardsVisible");
  await page.waitForFunction(
    (count) => document.querySelector(".cooking-db__count")?.textContent?.trim() === `${count} recipes`,
    RECIPE_SCROLL_FIXTURE_COUNT,
    { timeout: 30000 }
  );
  markStage(stage, "databaseCountReady");
  await page.waitForFunction(() => {
    const root = document.querySelector(".cooking-db__grid-container");
    const firstCard = document.querySelector(".cooking-db__card");
    const candidates = [];
    if (root) candidates.push(root, ...Array.from(root.querySelectorAll("*")));
    for (let element = firstCard?.parentElement; element; element = element.parentElement) candidates.push(element);
    return candidates.some((element) => element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 40);
  });
  markStage(stage, "gridReady");
  await findScrollElement(page);
  return { totalText: await page.locator(".cooking-db__count").innerText() };
}

// Per-card reveal means a real user sees the FIRST cover the moment its own decode settles,
// long before the rest of a large fixture finishes -- this is the metric that proves the fix
// (paired with waitForAllCoversSettled below, which still gates the scroll pass).
async function waitForFirstVisibleCovers(page, stage = null) {
  await page.waitForFunction(() => {
    const grid = document.querySelector(".cooking-db__grid-container");
    const firstCard = document.querySelector(".cooking-db__card");
    const candidates = [];
    if (grid) candidates.push(grid, ...Array.from(grid.querySelectorAll("*")));
    for (let element = firstCard?.parentElement; element; element = element.parentElement) candidates.push(element);
    const scrollElement = candidates.find((element) => {
      const style = window.getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 40 && style.overflowY !== "visible" && style.overflowY !== "hidden";
    });
    const viewport = (scrollElement ?? grid)?.getBoundingClientRect();
    if (!viewport) return false;
    const cards = Array.from(document.querySelectorAll(".cooking-db__card")).filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    });
    return cards.length > 0 && cards.every((card) => {
      const image = card.querySelector("img");
      const canvas = card.querySelector("canvas.cooking-db__cover-canvas[data-canvas-ready=\"true\"]");
      const imageReady = Boolean(image?.complete && image.naturalWidth > 1 && image.naturalHeight > 1);
      const canvasReady = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
      return card.getAttribute("data-has-cover") === "true" && card.getAttribute("data-image-state") === "ready" && (imageReady || canvasReady);
    });
  }, undefined, { timeout: 30000 });
  markStage(stage, "firstVisibleCoversReady");
}

// The synthetic scroll pass that follows must stay a clean scroll-mechanics measurement (zero
// residual image traffic, zero severe frames from background decode contention) -- so, unlike the
// app's own per-card reveal, this wait still requires every card in the fixture (not just the
// visible ones) to reach a terminal state before scrolling starts. Per-card reveal changed WHEN
// the grid shows each cover to a real user; it did not remove the need for a full fixture to
// eventually finish loading, and this benchmark still needs that finish line for a fair scroll test.
async function waitForAllCoversSettled(page, stage = null) {
  await page.waitForFunction((count) => {
    const cards = document.querySelectorAll(".cooking-db__card");
    if (cards.length !== count) return false;
    return Array.from(cards).every((card) => {
      const state = card.getAttribute("data-image-state");
      if (state !== "ready" && state !== "none" && state !== "error") return false;
      if (state !== "ready") return true;
      const image = card.querySelector("img");
      const canvas = card.querySelector("canvas.cooking-db__cover-canvas[data-canvas-ready=\"true\"]");
      const imageReady = Boolean(image?.complete && image.naturalWidth > 1 && image.naturalHeight > 1);
      const canvasReady = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
      return imageReady || canvasReady;
    });
  }, RECIPE_SCROLL_FIXTURE_COUNT, { timeout: 30000 });
  markStage(stage, "visibleCoversReady");
}

// The single in-page frame-gap monitor and per-frame cover sampler. It is stringified into the page
// (installScrollMonitor) and used by BOTH the programmatic pass and the wheel pass, so the two
// measurements are produced by identical instrumentation and stay comparable. Do not fork it.
// It only measures: the caller owns how the scroller is driven between start() and finish().
function createScrollMonitor() {
  const root = document.querySelector(".cooking-db__grid-container");
  const firstCard = document.querySelector(".cooking-db__card");
  const candidates = [];
  if (root) candidates.push(root, ...Array.from(root.querySelectorAll("*")));
  for (let element = firstCard?.parentElement; element; element = element.parentElement) candidates.push(element);
  const scrollElement = candidates.find((element) => {
    const style = window.getComputedStyle(element);
    return element.scrollHeight > element.clientHeight + 40 && style.overflowY !== "visible" && style.overflowY !== "hidden";
  });
  if (!scrollElement) throw new Error("Missing scrollable recipe grid element.");
  const maxScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  if (maxScroll <= 0) throw new Error("Recipe grid is not scrollable.");
  const frameGaps = [];
  const samples = [];
  let lastFrame = performance.now();
  let running = true;
  const visibleCards = () => {
    const viewport = scrollElement.getBoundingClientRect();
    return Array.from(document.querySelectorAll(".cooking-db__card")).filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right;
    });
  };
  const sample = (now) => {
    const cards = visibleCards();
    let emptyCovers = 0;
    let blankCovers = 0;
    let errorCovers = 0;
    let readyCovers = 0;
    let noCoverCards = 0;
    let incompleteImages = 0;
    let syntheticImages = 0;
    for (const card of cards) {
      const expectsCover = card.getAttribute("data-has-cover") === "true";
      const imageState = card.getAttribute("data-image-state");
      if (imageState !== "ready" && imageState !== "none" && imageState !== "error") blankCovers += 1;
      if (imageState === "error") errorCovers += 1;
      if (imageState === "ready") readyCovers += 1;
      if (imageState === "none") noCoverCards += 1;
      const cover = card.querySelector(".cooking-db__cover");
      if (expectsCover && cover?.classList.contains("cooking-db__cover--empty")) emptyCovers += 1;
      const image = card.querySelector("img");
      const canvas = card.querySelector('canvas.cooking-db__cover-canvas[data-canvas-ready="true"]');
      const canvasReady = Boolean(canvas && canvas.width > 0 && canvas.height > 0);
      if (expectsCover && canvasReady) continue;
      if (expectsCover && image && image.complete && image.naturalWidth <= 1 && image.naturalHeight <= 1) syntheticImages += 1;
      else if (expectsCover && (!image || !image.complete || image.naturalWidth === 0)) incompleteImages += 1;
    }
    samples.push({ now, renderedCards: document.querySelectorAll(".cooking-db__card").length, visibleCards: cards.length, emptyCovers, blankCovers, errorCovers, readyCovers, noCoverCards, incompleteImages, syntheticImages, scrollTop: scrollElement.scrollTop });
  };
  const monitor = (now) => {
    frameGaps.push(now - lastFrame);
    lastFrame = now;
    sample(now);
    if (running) requestAnimationFrame(monitor);
  };
  return {
    scrollElement,
    maxScroll,
    start() {
      requestAnimationFrame(monitor);
    },
    async finish() {
      running = false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        maxScroll,
        frameGaps,
        longFrames: frameGaps.filter((gap) => gap > 24).length,
        severeFrames: frameGaps.filter((gap) => gap > 50).length,
        sampleCount: samples.length,
        minRenderedCards: Math.min(...samples.map((sample) => sample.renderedCards)),
        minVisibleCards: Math.min(...samples.map((sample) => sample.visibleCards)),
        maxEmptyCovers: Math.max(...samples.map((sample) => sample.emptyCovers)),
        maxBlankCovers: Math.max(...samples.map((sample) => sample.blankCovers)),
        maxErrorCovers: Math.max(...samples.map((sample) => sample.errorCovers)),
        minReadyCovers: Math.min(...samples.map((sample) => sample.readyCovers)),
        maxNoCoverCards: Math.max(...samples.map((sample) => sample.noCoverCards)),
        maxIncompleteImages: Math.max(...samples.map((sample) => sample.incompleteImages)),
        maxSyntheticImages: Math.max(...samples.map((sample) => sample.syntheticImages)),
        maxObservedScrollTop: Math.max(...samples.map((sample) => sample.scrollTop)),
        endScrollTop: samples.length > 0 ? samples[samples.length - 1].scrollTop : null
      };
    }
  };
}

async function installScrollMonitor(page) {
  await page.evaluate(`globalThis.__MEP_CREATE_SCROLL_MONITOR__ = ${createScrollMonitor.toString()};`);
}

async function runScrollPass(page, scrollMs, transport) {
  await installScrollMonitor(page);
  const capture = transport.start();
  const result = await page.evaluate(async ({ scrollMs }) => {
    const monitor = globalThis.__MEP_CREATE_SCROLL_MONITOR__();
    const { scrollElement, maxScroll } = monitor;
    scrollElement.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    monitor.start();
    const run = (from, to) => new Promise((resolve) => {
      const started = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - started) / scrollMs);
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        scrollElement.scrollTop = from + (to - from) * eased;
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    await run(0, maxScroll);
    await run(maxScroll, 0);
    return monitor.finish();
  }, { scrollMs });
  return { ...result, transport: await transport.stop(capture) };
}

// Additive real-input pass: same monitor, same sampler, but the scroller is driven by dispatched
// wheel events under the pointer instead of by assigning scrollTop. That exercises hit-testing,
// wheel event handling and Chromium's compositor scroll animation, which the programmatic ramp
// bypasses entirely. Never feeds the release gate.
// Wait for the scroller to stop moving, so a gesture whose input queue is still draining is not
// cut short. Polling happens after the gesture, while the shared monitor keeps sampling.
async function waitForScrollSettle(page) {
  const deadline = Date.now() + WHEEL_SETTLE_TIMEOUT_MS;
  let previous = null;
  let settled = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WHEEL_SETTLE_POLL_MS));
    const current = await page.evaluate(() => globalThis.__MEP_ACTIVE_SCROLL_MONITOR__.scrollElement.scrollTop);
    if (previous !== null && Math.abs(current - previous) < 1) {
      settled = true;
      break;
    }
    previous = current;
  }
  return { settled, settleMs: Math.round(WHEEL_SETTLE_TIMEOUT_MS - (deadline - Date.now())) };
}

async function runWheelScrollPass(page, profile, transport) {
  await installScrollMonitor(page);
  const box = await page.locator(".cooking-db__grid-container").boundingBox();
  if (!box) throw new Error("Missing recipe grid container bounding box.");
  const capture = transport.start();
  const { maxScroll } = await page.evaluate(async () => {
    const monitor = globalThis.__MEP_CREATE_SCROLL_MONITOR__();
    globalThis.__MEP_ACTIVE_SCROLL_MONITOR__ = monitor;
    monitor.scrollElement.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    monitor.start();
    return { maxScroll: monitor.maxScroll };
  });
  const pointerX = box.x + box.width / 2;
  const pointerY = box.y + box.height / 2;
  await page.mouse.move(pointerX, pointerY);
  const cdp = profile.mode === "burst" ? await page.context().newCDPSession(page) : null;
  const dispatched = [];
  const wheel = (deltaY) => {
    if (!cdp) return page.mouse.wheel(0, deltaY);
    dispatched.push(cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: pointerX, y: pointerY, deltaX: 0, deltaY, modifiers: 0, pointerType: "mouse" }).catch(() => {}));
    return null;
  };
  const ticksPerDirection = Math.ceil(maxScroll / profile.deltaY) + 4;
  const startedAtMs = performance.now();
  let wheelEvents = 0;
  for (const direction of [1, -1]) {
    for (let tick = 0; tick < ticksPerDirection; tick += 1) {
      const acknowledged = wheel(direction * profile.deltaY);
      if (acknowledged) await acknowledged;
      wheelEvents += 1;
      if (profile.tickMs > 0) await new Promise((resolve) => setTimeout(resolve, profile.tickMs));
    }
  }
  const gestureMs = performance.now() - startedAtMs;
  await Promise.all(dispatched);
  const settle = await waitForScrollSettle(page);
  if (cdp) await cdp.detach().catch(() => {});
  const result = await page.evaluate(() => globalThis.__MEP_ACTIVE_SCROLL_MONITOR__.finish());
  await page.evaluate(() => {
    globalThis.__MEP_ACTIVE_SCROLL_MONITOR__.scrollElement.scrollTop = 0;
    globalThis.__MEP_ACTIVE_SCROLL_MONITOR__ = null;
  });
  return {
    ...result,
    profile: { name: profile.name, deltaY: profile.deltaY, tickMs: profile.tickMs, mode: profile.mode },
    gesture: {
      wheelEvents,
      ticksPerDirection,
      gestureMs: Math.round(gestureMs),
      settleMs: settle.settleMs,
      settled: settle.settled,
      eventsPerSecond: Number((wheelEvents / (gestureMs / 1000)).toFixed(1)),
      requestedPixelsPerSecond: Number(((wheelEvents * profile.deltaY) / (gestureMs / 1000)).toFixed(0)),
      reachedBottom: result.maxObservedScrollTop >= maxScroll - 2,
      returnedToTop: result.endScrollTop !== null && result.endScrollTop <= 2
    },
    transport: await transport.stop(capture)
  };
}

async function runDetailPagePass(page) {
  const firstCard = page.locator(".cooking-db__card").first();
  const navStart = performance.now();
  await firstCard.click();
  await page.waitForSelector(".recipe-view", { state: "visible", timeout: 10000 });
  const viewVisibleMs = Math.round(performance.now() - navStart);
  await page.waitForSelector(".recipe-view img", { state: "visible", timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll(".recipe-view img"));
    if (images.length === 0) return true;
    return Promise.all(images.map(async (image) => {
      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return false;
      try {
        await image.decode?.();
      } catch {
        return false;
      }
      return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    })).then((states) => states.every(Boolean));
  }, undefined, { timeout: 5000 });
  const images = await page.locator(".recipe-view img").all();
  const imageLoadTimes = await Promise.all(images.map(async (image) => ({ naturalWidth: await image.evaluate((element) => element.naturalWidth).catch(() => 0) })));
  if (imageLoadTimes.some((image) => image.naturalWidth <= 0)) {
    throw new Error("Recipe detail contains an incomplete image.");
  }
  await page.click('button.mep-nav__item:has-text("Recipe Database")').catch(() => {});
  await page.waitForSelector(".cooking-db__card", { state: "visible", timeout: 10000 });
  return { viewVisibleMs, totalImages: imageLoadTimes.length, loadedImages: imageLoadTimes.filter((image) => image.naturalWidth > 0).length, allImagesLoaded: imageLoadTimes.every((image) => image.naturalWidth > 0) };
}

async function runSearchPass(page) {
  const search = page.locator(".cooking-db__search");
  const start = await page.evaluate(() => performance.now());
  await search.fill("Visual Fixture 257");
  await page.waitForFunction(() => document.querySelectorAll(".cooking-db__card").length === 1, undefined, { timeout: 10000 });
  const inputToResultsMs = Math.round((await page.evaluate(() => performance.now())) - start);
  const resultPath = await page.locator(".cooking-db__card").getAttribute("data-path");
  const resultCount = await page.locator(".cooking-db__card").count();
  await search.fill("");
  await page.waitForFunction(() => document.querySelectorAll(".cooking-db__card").length > 1, undefined, { timeout: 10000 });
  return { inputToResultsMs, resultCount, resultPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const powerState = await detectPowerState();
  if (!args.allowBattery && powerState.detected && powerState.onBattery) {
    console.error("refusing to benchmark on battery — results would be meaningless; plug in AC");
    process.exitCode = 2;
    return;
  }
  let browser;
  let isolatedServer;
  const runs = [];
  let activeRunState = null;
  try {
    if (!process.env.MEP_SCROLL_BENCHMARK_URL && args.url === DEFAULT_URL) {
      isolatedServer = await startIsolatedWebHost();
      args.url = isolatedServer.url;
    }
    browser = await chromium.launch({ headless: args.headless });
    for (let index = 0; index < args.runs; index += 1) {
      const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
      const page = await context.newPage();
      const diagnostics = installDiagnostics(page);
      const transport = createTransportCapture(page);
      const timeout = Math.max(DEFAULT_OPERATION_TIMEOUT_MS, args.scrollMs * 8 + 10000);
      const coldStage = createStage();
      activeRunState = { run: index + 1, page, diagnostics, transport, stages: { cold: coldStage, warm: null } };
      await installPerformanceEvidence(page);
      const environment = { ...hostEnvironment(), browserUserAgent: await page.evaluate(() => navigator.userAgent), viewport: DEFAULT_VIEWPORT };
      const coldReadinessCapture = transport.start(coldStage.startedAtMs);
      const coldReadinessStartedAt = performance.now();
      await withTimeout(waitForRecipeDatabase(page, args.url, { stage: coldStage }), timeout, `cold page preparation ${index + 1}`);
      await withTimeout(waitForFirstVisibleCovers(page, coldStage), timeout, `cold first-cover readiness ${index + 1}`);
      const coldFirstVisibleCoverMs = Math.round(performance.now() - coldReadinessStartedAt);
      await withTimeout(waitForAllCoversSettled(page, coldStage), timeout, `cold cover readiness ${index + 1}`);
      const coldReadinessMs = Math.round(performance.now() - coldReadinessStartedAt);
      const coldReadinessTransport = await transport.stop(coldReadinessCapture);
      const coldReadinessPerformance = await collectPerformanceEvidence(page);
      markStage(coldStage, "scrollStarted");
      const coldScroll = await withTimeout(runScrollPass(page, args.scrollMs, transport), timeout, `cold scroll run ${index + 1}`);
      markStage(coldStage, "scrollCompleted");
      const coldScrollPerformance = await collectPerformanceEvidence(page);

      const warmStage = createStage();
      activeRunState.stages.warm = warmStage;
      const warmReadinessCapture = transport.start(warmStage.startedAtMs);
      const warmReadinessStartedAt = performance.now();
      await withTimeout(waitForRecipeDatabase(page, args.url, { stage: warmStage }), timeout, `warm page preparation ${index + 1}`);
      await withTimeout(waitForFirstVisibleCovers(page, warmStage), timeout, `warm first-cover readiness ${index + 1}`);
      const warmFirstVisibleCoverMs = Math.round(performance.now() - warmReadinessStartedAt);
      await withTimeout(waitForAllCoversSettled(page, warmStage), timeout, `warm cover readiness ${index + 1}`);
      const warmReadinessMs = Math.round(performance.now() - warmReadinessStartedAt);
      const warmReadinessTransport = await transport.stop(warmReadinessCapture);
      const warmReadinessPerformance = await collectPerformanceEvidence(page);
      markStage(warmStage, "scrollStarted");
      const warmScroll = await withTimeout(runScrollPass(page, args.scrollMs, transport), timeout, `warm scroll run ${index + 1}`);
      markStage(warmStage, "scrollCompleted");
      const warmScrollPerformance = await collectPerformanceEvidence(page);
      const wheelScrolls = [];
      if (args.wheelScroll) {
        for (const profile of WHEEL_SCROLL_PROFILES) {
          markStage(warmStage, `wheelScrollStarted:${profile.name}`);
          const wheelScroll = await withTimeout(runWheelScrollPass(page, profile, transport), WHEEL_PASS_TIMEOUT_MS, `warm wheel scroll ${profile.name} run ${index + 1}`);
          markStage(warmStage, `wheelScrollCompleted:${profile.name}`);
          wheelScrolls.push(wheelScroll);
          console.log(`run=${index + 1} wheel=${profile.name} mode=${profile.mode} events=${wheelScroll.gesture.wheelEvents} rate=${wheelScroll.gesture.eventsPerSecond}/s speed=${wheelScroll.gesture.requestedPixelsPerSecond}px/s gestureMs=${wheelScroll.gesture.gestureMs} reachedBottom=${wheelScroll.gesture.reachedBottom} p95=${formatMs(percentile(wheelScroll.frameGaps, 95))} max=${formatMs(Math.max(...wheelScroll.frameGaps))} long=${wheelScroll.longFrames} severe=${wheelScroll.severeFrames} maxBlank=${wheelScroll.maxBlankCovers} maxIncomplete=${wheelScroll.maxIncompleteImages}`);
        }
      }
      const result = {
        environment,
        phaseTimestamps: { cold: stageSnapshot(coldStage), warm: stageSnapshot(warmStage) },
        performanceEvidence: {
          cold: { readiness: coldReadinessPerformance, scroll: coldScrollPerformance },
          warm: { readiness: warmReadinessPerformance, scroll: warmScrollPerformance }
        },
        cold: { readinessMs: coldReadinessMs, firstVisibleCoverMs: coldFirstVisibleCoverMs, readinessTransport: coldReadinessTransport, scroll: coldScroll },
        warm: { readinessMs: warmReadinessMs, firstVisibleCoverMs: warmFirstVisibleCoverMs, readinessTransport: warmReadinessTransport, scroll: warmScroll },
        wheelScroll: wheelScrolls,
        diagnostics
      };
      runs.push(result);
      console.log(`run=${index + 1} coldFirstCover=${coldFirstVisibleCoverMs}ms coldReady=${coldReadinessMs}ms warmFirstCover=${warmFirstVisibleCoverMs}ms warmReady=${warmReadinessMs}ms coldRequests=${coldScroll.transport.requests} coldBytes=${coldScroll.transport.transferredBytes} warmRequests=${warmScroll.transport.requests} warmBytes=${warmScroll.transport.transferredBytes} coldP95=${formatMs(percentile(coldScroll.frameGaps, 95))} coldMax=${formatMs(Math.max(...coldScroll.frameGaps))} warmP95=${formatMs(percentile(warmScroll.frameGaps, 95))} warmMax=${formatMs(Math.max(...warmScroll.frameGaps))} minVisible=${Math.min(coldScroll.minVisibleCards, warmScroll.minVisibleCards)} maxIncomplete=${Math.max(coldScroll.maxIncompleteImages, warmScroll.maxIncompleteImages)}`);
      if (index === 0) {
        const detail = await withTimeout(runDetailPagePass(page), timeout, "detail-page pass");
        const search = await withTimeout(runSearchPass(page), timeout, "recipe-search pass");
        result.detail = detail;
        result.search = search;
      }
      await context.close();
      activeRunState = null;
    }

    const allScrolls = runs.flatMap((run) => [run.cold.scroll, run.warm.scroll]);
    const coldScrolls = runs.map((run) => run.cold.scroll);
    const warmScrolls = runs.map((run) => run.warm.scroll);
    const allFrameP95 = allScrolls.map((scroll) => percentile(scroll.frameGaps, 95));
    const allFrameMax = allScrolls.map((scroll) => Math.max(...scroll.frameGaps));
    const artifactIdentity = await getArtifactIdentity();
    const summary = {
      url: process.env.MEP_SCROLL_BENCHMARK_URL ? args.url : "isolated-web-host",
      workload: { recipes: RECIPE_SCROLL_FIXTURE_COUNT, raster: "png", phases: ["cold", "warm"] },
      runs: args.runs,
      completedRuns: runs.length,
      powerState,
      artifactGeneratedAt: artifactIdentity.generatedAt,
      buildIdentity: artifactIdentity,
      viewport: DEFAULT_VIEWPORT,
      thresholds: {
        frameP95Ms: args.targetP95Ms,
        coldReadinessP95Ms: args.coldReadinessP95Ms,
        warmReadinessP95Ms: args.warmReadinessP95Ms,
        firstVisibleCoverP95Ms: args.firstVisibleCoverP95Ms,
        scrollImageResponses: 0,
        scrollImageBytes: 0
      },
      runtime: { userAgent: await browser.newPage().then(async (page) => { const value = await page.evaluate(() => navigator.userAgent); await page.close(); return value; }) },
      totalText: `${RECIPE_SCROLL_FIXTURE_COUNT} recipes`,
      readinessMs: { cold: summarize(runs.map((run) => run.cold.readinessMs)), warm: summarize(runs.map((run) => run.warm.readinessMs)) },
      firstVisibleCoverMs: { cold: summarize(runs.map((run) => run.cold.firstVisibleCoverMs)), warm: summarize(runs.map((run) => run.warm.firstVisibleCoverMs)) },
      imageTransport: {
        coldReadiness: summarize(runs.map((run) => run.cold.readinessTransport.transferredBytes)),
        warmReadiness: summarize(runs.map((run) => run.warm.readinessTransport.transferredBytes)),
        coldReadinessRequests: summarize(runs.map((run) => run.cold.readinessTransport.requests)),
        warmReadinessRequests: summarize(runs.map((run) => run.warm.readinessTransport.requests)),
        coldReadinessResponses: summarize(runs.map((run) => run.cold.readinessTransport.responses)),
        warmReadinessResponses: summarize(runs.map((run) => run.warm.readinessTransport.responses)),
        coldReadinessUniqueImages: summarize(runs.map((run) => run.cold.readinessTransport.uniqueImages)),
        warmReadinessUniqueImages: summarize(runs.map((run) => run.warm.readinessTransport.uniqueImages)),
        coldScrollRequests: summarize(runs.map((run) => run.cold.scroll.transport.requests)),
        warmScrollRequests: summarize(runs.map((run) => run.warm.scroll.transport.requests)),
        coldScrollResponses: summarize(runs.map((run) => run.cold.scroll.transport.responses)),
        warmScrollResponses: summarize(runs.map((run) => run.warm.scroll.transport.responses)),
        coldScrollBytes: summarize(runs.map((run) => run.cold.scroll.transport.transferredBytes)),
        warmScrollBytes: summarize(runs.map((run) => run.warm.scroll.transport.transferredBytes)),
        coldScrollUniqueImages: summarize(runs.map((run) => run.cold.scroll.transport.uniqueImages)),
        warmScrollUniqueImages: summarize(runs.map((run) => run.warm.scroll.transport.uniqueImages)),
        thumbnailVariants: {
          coldReadiness: summarizeVariantTransport(runs, (run) => run.cold.readinessTransport),
          warmReadiness: summarizeVariantTransport(runs, (run) => run.warm.readinessTransport),
          coldScroll: summarizeVariantTransport(runs, (run) => run.cold.scroll.transport),
          warmScroll: summarizeVariantTransport(runs, (run) => run.warm.scroll.transport)
        }
      },
      p95FrameGap: summarize(allFrameP95),
      maxFrameGap: summarize(allFrameMax),
      frameP95Ms: {
        cold: summarize(coldScrolls.map((scroll) => percentile(scroll.frameGaps, 95))),
        warm: summarize(warmScrolls.map((scroll) => percentile(scroll.frameGaps, 95)))
      },
      frameMaxMs: {
        cold: summarize(coldScrolls.map((scroll) => Math.max(...scroll.frameGaps))),
        warm: summarize(warmScrolls.map((scroll) => Math.max(...scroll.frameGaps)))
      },
      totalLongFrames: allScrolls.reduce((sum, scroll) => sum + scroll.longFrames, 0),
      totalSevereFrames: allScrolls.reduce((sum, scroll) => sum + scroll.severeFrames, 0),
      minVisibleCards: Math.min(...allScrolls.map((scroll) => scroll.minVisibleCards)),
      maxEmptyCovers: Math.max(...allScrolls.map((scroll) => scroll.maxEmptyCovers)),
      maxBlankCovers: Math.max(...allScrolls.map((scroll) => scroll.maxBlankCovers)),
      maxErrorCovers: Math.max(...allScrolls.map((scroll) => scroll.maxErrorCovers)),
      minReadyCovers: Math.min(...allScrolls.map((scroll) => scroll.minReadyCovers)),
      maxNoCoverCards: Math.max(...allScrolls.map((scroll) => scroll.maxNoCoverCards)),
      maxIncompleteImages: Math.max(...allScrolls.map((scroll) => scroll.maxIncompleteImages)),
      maxSyntheticImages: Math.max(...allScrolls.map((scroll) => scroll.maxSyntheticImages)),
      recipeOpen: runs[0].detail,
      recipeSearch: runs[0].search,
      consoleDiagnostics: runs.flatMap((run) => run.diagnostics.consoleDiagnostics),
      failedRequests: runs.flatMap((run) => run.diagnostics.failedRequests),
      runMetrics: runs.map((run, index) => serializeRunMetric(run, index + 1))
    };
    // Additive, non-gating: the wheel pass measures the real input path with the same monitor and
    // sampler, but it is deliberately excluded from evidenceFailures and from every budget key that
    // scripts/check-release-budgets.mjs reads.
    const wheelProfiles = args.wheelScroll
      ? Object.fromEntries(WHEEL_SCROLL_PROFILES.map((profile) => [profile.name, summarizeWheelProfile(runs, profile.name)]).filter(([, value]) => value))
      : {};
    summary.wheelScroll = {
      enabled: Boolean(args.wheelScroll),
      gating: false,
      note: "Real-input wheel pass. Same in-page rAF frame-gap monitor and per-frame cover sampler as the programmatic pass; drives the scroller with page.mouse.wheel over .cooking-db__grid-container. Warm phase only, immediately after the warm programmatic pass. Never feeds evaluateScrollArtifact or release budgets.",
      programmaticWarmBaseline: summarizeProgrammaticScrolls(warmScrolls),
      programmaticColdBaseline: summarizeProgrammaticScrolls(coldScrolls),
      profiles: wheelProfiles
    };
    summary.evidenceFailures = evaluateScrollArtifact(summary);
    summary.status = summary.evidenceFailures.length === 0 ? "pass" : "fail";
    summary.passed = summary.status === "pass";
    console.log(`summary=${JSON.stringify(summary)}`);
    if (args.output) {
      await writeFile(args.output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      console.log(`wrote=${args.output}`);
    }
    if (args.wheelScroll) {
      const row = (label, metric) => ({
        pass: label,
        frameP95Median: formatMs(metric.frameP95Ms.median),
        frameP95Max: formatMs(metric.frameP95Ms.max),
        frameMax: formatMs(metric.frameMaxMs.max),
        longFrames: metric.totalLongFrames,
        severeFrames: metric.totalSevereFrames,
        maxBlankCovers: metric.maxBlankCovers,
        maxIncompleteImages: metric.maxIncompleteImages
      });
      printScrollInputComparison([
        row(`programmatic warm (x${summary.wheelScroll.programmaticWarmBaseline.passes})`, summary.wheelScroll.programmaticWarmBaseline),
        row(`programmatic cold (x${summary.wheelScroll.programmaticColdBaseline.passes})`, summary.wheelScroll.programmaticColdBaseline),
        ...Object.entries(summary.wheelScroll.profiles).map(([name, metric]) => row(`wheel ${name} (x${metric.passes})`, metric))
      ]);
      for (const [name, metric] of Object.entries(summary.wheelScroll.profiles)) {
        console.log(`wheel ${name}: mode=${metric.profile.mode} deltaY=${metric.profile.deltaY}px tickMs=${metric.profile.tickMs} events=${metric.gesture.wheelEvents.median} rate=${metric.gesture.eventsPerSecond.median}/s requested=${metric.gesture.requestedPixelsPerSecond.median}px/s gestureMs=${metric.gesture.gestureMs.median} travel=${metric.travel.maxObservedScrollTop.min}/${metric.travel.maxScroll.max}px reachedBottom=${metric.gesture.reachedBottomPasses}/${metric.passes} returnedToTop=${metric.gesture.returnedToTopPasses}/${metric.passes} settleMs=${metric.gesture.settleMs.median} settled=${metric.gesture.settledPasses}/${metric.passes} minVisibleCards=${metric.minVisibleCards} maxEmptyCovers=${metric.maxEmptyCovers} scrollImageResponses=${metric.transport.responses.max}`);
      }
    }
    const failures = [...summary.evidenceFailures];
    if (summary.consoleDiagnostics.length > 0) failures.push(`${summary.consoleDiagnostics.length} console diagnostics`);
    if (summary.failedRequests.length > 0) failures.push(`${summary.failedRequests.length} failed requests`);
    if (summary.p95FrameGap.p95 > args.targetP95Ms) failures.push(`p95 frame gap ${formatMs(summary.p95FrameGap.p95)} > ${formatMs(args.targetP95Ms)}`);
    if (summary.totalSevereFrames > 0) failures.push(`severe frames ${summary.totalSevereFrames} > 0`);
    if (summary.readinessMs.cold.p95 > args.coldReadinessP95Ms) failures.push(`cold readiness p95 ${formatMs(summary.readinessMs.cold.p95)} > ${formatMs(args.coldReadinessP95Ms)}`);
    if (summary.readinessMs.warm.p95 > args.warmReadinessP95Ms) failures.push(`warm readiness p95 ${formatMs(summary.readinessMs.warm.p95)} > ${formatMs(args.warmReadinessP95Ms)}`);
    if (summary.firstVisibleCoverMs.cold.p95 > args.firstVisibleCoverP95Ms) failures.push(`cold first-visible-cover p95 ${formatMs(summary.firstVisibleCoverMs.cold.p95)} > ${formatMs(args.firstVisibleCoverP95Ms)}`);
    if (summary.firstVisibleCoverMs.warm.p95 > args.firstVisibleCoverP95Ms) failures.push(`warm first-visible-cover p95 ${formatMs(summary.firstVisibleCoverMs.warm.p95)} > ${formatMs(args.firstVisibleCoverP95Ms)}`);
    if (summary.maxEmptyCovers > 0) failures.push(`${summary.maxEmptyCovers} visible expected-cover blanks`);
    if (summary.maxBlankCovers > 0) failures.push(`${summary.maxBlankCovers} visible cards without a terminal image state`);
    if (summary.maxErrorCovers > 0) failures.push(`${summary.maxErrorCovers} visible fixture cover errors`);
    if (summary.maxIncompleteImages > 0) failures.push(`${summary.maxIncompleteImages} visible incomplete images`);
    if (summary.maxSyntheticImages > 0) failures.push(`${summary.maxSyntheticImages} visible synthetic images`);
    if (
      summary.imageTransport.coldScrollResponses.max > 0 ||
      summary.imageTransport.coldScrollBytes.max > 0 ||
      summary.imageTransport.coldScrollUniqueImages.max > 0
    ) {
      failures.push(`cold scroll image responses/bytes/unique ${summary.imageTransport.coldScrollResponses.max}/${summary.imageTransport.coldScrollBytes.max}/${summary.imageTransport.coldScrollUniqueImages.max} > 0`);
    }
    if (
      summary.imageTransport.warmScrollResponses.max > 0 ||
      summary.imageTransport.warmScrollBytes.max > 0 ||
      summary.imageTransport.warmScrollUniqueImages.max > 0
    ) {
      failures.push(`warm scroll image responses/bytes/unique ${summary.imageTransport.warmScrollResponses.max}/${summary.imageTransport.warmScrollBytes.max}/${summary.imageTransport.warmScrollUniqueImages.max} > 0`);
    }
    if (failures.length > 0) {
      console.error(`benchmark failed: ${failures.join("; ")}`);
      process.exitCode = 1;
    }
  } catch (error) {
    const failure = {
      url: process.env.MEP_SCROLL_BENCHMARK_URL ? args.url : "isolated-web-host",
      requestedRuns: args.runs,
      completedRuns: runs.length,
      powerState,
      viewport: DEFAULT_VIEWPORT,
      thresholds: {
        frameP95Ms: args.targetP95Ms,
        coldReadinessP95Ms: args.coldReadinessP95Ms,
        warmReadinessP95Ms: args.warmReadinessP95Ms,
        firstVisibleCoverP95Ms: args.firstVisibleCoverP95Ms,
        scrollImageResponses: 0,
        scrollImageBytes: 0
      },
      stageTimestamps: activeRunState
        ? Object.fromEntries(Object.entries(activeRunState.stages).map(([name, stage]) => [name, stageSnapshot(stage)]))
        : {},
      transport: activeRunState?.transport?.snapshot() ?? null,
      domState: await collectDomState(activeRunState?.page).catch(() => null),
      consoleDiagnostics: activeRunState?.diagnostics?.consoleDiagnostics ?? [],
      failedRequests: activeRunState?.diagnostics?.failedRequests ?? [],
      isolatedHostOutputTail: isolatedServer?.hostOutputTail?.() ?? (error && typeof error === "object" ? error.hostOutputTail : null),
      error: errorMessage(error)
    };
    console.error(`benchmark failed: ${failure.error}`);
    if (args.output) {
      try {
        await writeFile(args.output, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
        console.log(`wrote=${args.output}`);
      } catch (writeError) {
        console.error(`failed to write failure result: ${errorMessage(writeError)}`);
      }
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch((error) => console.error(`failed to close browser: ${errorMessage(error)}`));
    if (isolatedServer) await isolatedServer.close().catch((error) => console.error(`failed to close isolated web host: ${errorMessage(error)}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`benchmark failed before browser setup: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
