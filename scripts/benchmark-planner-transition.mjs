#!/usr/bin/env node
// Frozen Database -> Planner perceived-transition benchmark.
// Exact presentation authority is buffered PerformanceElementTiming; DOM is post-window correctness only.

import { chromium } from "@playwright/test";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createRecipeScrollFixture } from "./generate-recipe-scroll-fixture.mjs";

const execFileAsync = promisify(execFile);
const DEADLINE_MS = 30_000;
const HOST_START_TIMEOUT_MS = 60_000;
const HOST_SHUTDOWN_GRACE_MS = 5_000;
const PRESS_DWELL_MS = 80;
const CLICK_TO_PRESENTATION_BUDGET_MS = 50;
const POINTERDOWN_TO_PRESENTATION_BUDGET_MS = 130;
const VIEWPORT = { width: 1440, height: 1000 };
const PLACEHOLDER_IDS = [
  "mep:planner-placeholder:metadata",
  "mep:planner-placeholder:suspense",
];
const SHELL_ID = "mep:planner-shell";
const WEEK_ID = "mep:planner-week-range";

export function isoWeekDates(now = new Date()) {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  const dates = [];
  for (let index = 0; index < 7; index += 1) {
    const next = new Date(date);
    next.setDate(date.getDate() + index);
    dates.push([
      next.getFullYear(),
      String(next.getMonth() + 1).padStart(2, "0"),
      String(next.getDate()).padStart(2, "0"),
    ].join("-"));
  }
  return dates;
}

export function expectedFixture(dates = isoWeekDates()) {
  const custom = [
    { path: "planner/marked-task.md", title: "Marked Task", type: "task", marked: true, lane: "marked" },
    { path: "recipes/visual-fixture-001.md", title: "Visual Fixture 001", type: "recipe", scheduled: dates[0], lane: dates[0] },
    { path: "recipes/visual-fixture-002.md", title: "Visual Fixture 002", type: "recipe", scheduled: dates[1], lane: dates[1] },
    { path: "recipes/visual-fixture-003.md", title: "Visual Fixture 003", type: "recipe", scheduled: dates[2], lane: dates[2] },
    { path: "recipes/visual-fixture-004.md", title: "Visual Fixture 004", type: "recipe", scheduled: dates[3], lane: dates[3] },
    { path: "planner/friday-task.md", title: "Friday Task", type: "task", scheduled: dates[4], lane: dates[4] },
    { path: "planner/saturday-reminder.md", title: "Saturday Reminder", type: "reminder", scheduled: dates[5], lane: dates[5] },
    { path: "planner/sunday-exercise.md", title: "Sunday Exercise", type: "exercise", scheduled: dates[6], lane: dates[6] },
  ];
  const laneOrder = ["marked", ...dates];
  const lanes = laneOrder.map((id) => ({
    id,
    cardIds: custom.filter((card) => card.lane === id).map((card) => `${card.path}::${id}`),
  }));
  const anchor = custom[1];
  return {
    presetId: "weekly",
    weekStart: dates[0],
    weekEnd: dates[6],
    lanes,
    cards: custom,
    anchorEntryId: `${anchor.path}::${anchor.lane}`,
    anchorTitle: anchor.title,
    anchorIdentifier: `mep:planner-card-title:${anchor.path}::${anchor.lane}`,
    weekIdentifier: WEEK_ID,
  };
}

function sameIdentity(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify({
    presetId: expected.presetId,
    weekStart: expected.weekStart,
    weekEnd: expected.weekEnd,
    lanes: expected.lanes,
  });
}

function entriesAfter(entries, identifier, start) {
  return entries.filter((entry) => entry.identifier === identifier && entry.renderTime > start);
}

export function deriveTransitionSample(raw, expected) {
  const fail = (reason) => ({ status: "UNDERIVABLE", reason });
  if (!raw || !expected) return fail("missing raw sample or expected identity");
  const pointerdowns = raw.gestures?.filter((entry) => entry.type === "pointerdown" && entry.isTrusted) ?? [];
  const clicks = raw.gestures?.filter((entry) => entry.type === "click" && entry.isTrusted) ?? [];
  if (pointerdowns.length !== 1) return fail(`trusted pointerdown count ${pointerdowns.length} !== 1`);
  if (clicks.length !== 1) return fail(`trusted click count ${clicks.length} !== 1`);
  const pointerdown = pointerdowns[0].timeStamp;
  const click = clicks[0].timeStamp;
  if (!(click >= pointerdown) || click - pointerdown < PRESS_DWELL_MS - 8) {
    return fail(`physical press dwell ${click - pointerdown}ms is below tolerance`);
  }
  const semantics = (raw.marks ?? []).filter((entry) => (
    entry.name === "mep:planner:semantic-ready" && entry.startTime > pointerdown
  ));
  if (semantics.length !== 1) return fail(`current-window semantic-ready count ${semantics.length} !== 1`);
  const semantic = semantics[0];
  if (!Number.isInteger(semantic.detail?.generation) || semantic.detail.generation <= 0) {
    return fail("semantic-ready has invalid transition generation");
  }
  const identity = {
    presetId: semantic.detail?.presetId,
    weekStart: semantic.detail?.weekStart,
    weekEnd: semantic.detail?.weekEnd,
    lanes: semantic.detail?.lanes,
  };
  if (!sameIdentity(identity, expected)) return fail("semantic-ready board identity is wrong, incomplete, duplicated, or misordered");
  const week = entriesAfter(raw.elements ?? [], expected.weekIdentifier, pointerdown);
  const anchor = entriesAfter(raw.elements ?? [], expected.anchorIdentifier, pointerdown);
  if (week.length !== 1) return fail(`exact week presentation count ${week.length} !== 1`);
  if (anchor.length !== 1) return fail(`exact anchor presentation count ${anchor.length} !== 1`);
  if (!(week[0].renderTime > click) || !(anchor[0].renderTime > click)) {
    return fail("exact presentation did not occur after the trusted click");
  }
  const presentation = Math.max(week[0].renderTime, anchor[0].renderTime);
  const placeholders = (raw.elements ?? []).filter((entry) => (
    PLACEHOLDER_IDS.includes(entry.identifier)
    && entry.renderTime > pointerdown
    && entry.renderTime <= presentation
  ));
  if (placeholders.length > 0) return fail(`planner placeholder exactly presented: ${placeholders.map((x) => x.identifier).join(", ")}`);
  const earlyShells = entriesAfter(raw.elements ?? [], SHELL_ID, pointerdown)
    .filter((entry) => entry.renderTime < presentation);
  if (earlyShells.length > 0) return fail("planner shell exactly presented before the exact populated target");
  if (week[0].renderTime < presentation) return fail("planner toolbar exactly presented before the anchor card");
  const clickToPresentationMs = presentation - click;
  const pointerdownToPresentationMs = presentation - pointerdown;
  if (clickToPresentationMs > 1_000) return fail(`sample contamination: click-to-presentation ${clickToPresentationMs}ms > 1000ms`);
  return {
    status: "OK",
    generation: semantic.detail.generation,
    pointerdownTime: pointerdown,
    clickTime: click,
    semanticReadyTime: semantic.startTime,
    weekRenderTime: week[0].renderTime,
    anchorRenderTime: anchor[0].renderTime,
    presentationTime: presentation,
    clickToPresentationMs,
    pointerdownToPresentationMs,
    pressDwellMs: click - pointerdown,
    longTasks: (raw.longTasks ?? []).filter((entry) => entry.startTime >= pointerdown && entry.startTime <= presentation),
    layoutShifts: (raw.layoutShifts ?? []).filter((entry) => entry.startTime >= pointerdown && entry.startTime <= presentation),
  };
}

function observerSetup() {
  var resolveDatabase;
  var resolveDataset;
  var resolveFailure;
  var resolveTransition;
  window.__mepPlannerTransitionDatabaseReady = new Promise(function (resolve) { resolveDatabase = resolve; });
  window.__mepPlannerTransitionDatasetReady = new Promise(function (resolve) { resolveDataset = resolve; });
  window.__mepPlannerTransitionFailure = new Promise(function (resolve) { resolveFailure = resolve; });
  window.__mepPlannerTransitionEndpoint = new Promise(function (resolve) { resolveTransition = resolve; });
  window.__mepPlannerTransition = {
    expected: null, databaseResolved: false, transitionResolved: false,
    gestures: [], marks: [], elements: [], longTasks: [], layoutShifts: [], errors: [],
  };
  window.__mepConfigurePlannerTransition = function (expected) {
    window.__mepPlannerTransition.expected = expected;
    checkTransition();
  };
  function serialise(entry) {
    return {
      name: entry.name,
      identifier: entry.identifier || "",
      entryType: entry.entryType,
      startTime: entry.startTime,
      renderTime: Number(entry.renderTime || 0),
      duration: entry.duration,
      value: entry.value,
      hadRecentInput: entry.hadRecentInput,
      detail: entry.detail,
    };
  }
  function checkDatabase() {
    if (window.__mepPlannerTransition.databaseResolved) return;
    var semantic = window.__mepPlannerTransition.marks.find(function (entry) { return entry.name === "mep:database:semantic-ready"; });
    var paths = semantic && semantic.detail && semantic.detail.firstFourPaths;
    if (!Array.isArray(paths) || paths.length !== 4 || new Set(paths).size !== 4) return;
    for (var i = 0; i < paths.length; i += 1) {
      var found = window.__mepPlannerTransition.elements.filter(function (entry) { return entry.identifier === paths[i] && entry.renderTime > 0; });
      if (found.length !== 1) return;
    }
    window.__mepPlannerTransition.databaseResolved = true;
    resolveDatabase({ paths: paths.slice(), semanticTime: semantic.startTime });
  }
  function checkTransition() {
    if (window.__mepPlannerTransition.transitionResolved) return;
    var expected = window.__mepPlannerTransition.expected;
    var pointer = window.__mepPlannerTransition.gestures.find(function (entry) { return entry.type === "pointerdown" && entry.isTrusted; });
    if (!expected || !pointer) return;
    var semantics = window.__mepPlannerTransition.marks.filter(function (entry) {
      return entry.name === "mep:planner:semantic-ready" && entry.startTime > pointer.timeStamp;
    });
    var exactSemantic = semantics.find(function (entry) {
      var detail = entry.detail || {};
      return JSON.stringify({ presetId: detail.presetId, weekStart: detail.weekStart, weekEnd: detail.weekEnd, lanes: detail.lanes }) === JSON.stringify({ presetId: expected.presetId, weekStart: expected.weekStart, weekEnd: expected.weekEnd, lanes: expected.lanes });
    });
    if (!exactSemantic) return;
    var week = window.__mepPlannerTransition.elements.find(function (entry) { return entry.identifier === expected.weekIdentifier && entry.renderTime > pointer.timeStamp; });
    var anchor = window.__mepPlannerTransition.elements.find(function (entry) { return entry.identifier === expected.anchorIdentifier && entry.renderTime > pointer.timeStamp; });
    if (!week || !anchor) return;
    window.__mepPlannerTransition.transitionResolved = true;
    resolveTransition(true);
  }
  ["pointerdown", "click"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (!event.isTrusted || window.__mepPlannerTransition.transitionResolved) return;
      window.__mepPlannerTransition.gestures.push({ type: type, timeStamp: event.timeStamp, isTrusted: event.isTrusted, button: event.button });
      checkTransition();
    }, true);
  });
  try {
    ["mark", "element", "longtask", "layout-shift"].forEach(function (type) {
      var observer = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          var serialised = serialise(entry);
          if (type === "mark") {
            window.__mepPlannerTransition.marks.push(serialised);
            if (serialised.name === "mep:planner:dataset-ready") {
              resolveDataset(serialised.detail);
            } else if (serialised.name === "mep:planner:navigation-failed") {
              resolveFailure(serialised.detail);
            }
          } else if (type === "element") window.__mepPlannerTransition.elements.push(serialised);
          else if (type === "longtask") window.__mepPlannerTransition.longTasks.push(serialised);
          else window.__mepPlannerTransition.layoutShifts.push(serialised);
        });
        checkDatabase();
        checkTransition();
      });
      observer.observe({ type: type, buffered: true });
    });
  } catch (error) {
    window.__mepPlannerTransition.errors.push(String(error));
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function findHelper() {
  for (const candidate of [process.env.MEP_REMOTE_HOST_HELPER, "target/release/mep-remote-host-helper", "target/debug/mep-remote-host-helper"].filter(Boolean)) {
    try { await access(candidate); return path.resolve(candidate); } catch { /* next */ }
  }
  await execFileAsync("npm", ["run", "build:remote-helper"]);
  return path.resolve("target/debug/mep-remote-host-helper");
}

async function closeChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, HOST_SHUTDOWN_GRACE_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function startHost(fixture, helper) {
  await access(helper);
  const port = await freePort();
  const thumbnailCache = path.join(fixture.root, "thumbnail-cache");
  const home = path.join(fixture.root, "home");
  const xdgCache = path.join(home, ".cache");
  const xdgConfig = path.join(home, ".config");
  const xdgData = path.join(home, ".local", "share");
  await Promise.all([mkdir(thumbnailCache, { recursive: true }), mkdir(xdgCache, { recursive: true }), mkdir(xdgConfig, { recursive: true }), mkdir(xdgData, { recursive: true })]);
  const child = spawn("node", ["scripts/start-web-host.mjs", "--vault", fixture.vaultRoot, "--appdata", fixture.appDataRoot, "--thumbnail-cache", thumbnailCache, "--rust-helper", helper, "--host", "127.0.0.1", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, XDG_CACHE_HOME: xdgCache, XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData, MEP_REMOTE_HOST_HELPER: helper },
  });
  let output = "";
  const started = new Promise((resolve, reject) => {
    const onData = (chunk) => { output = `${output}${chunk}`.slice(-12000); if (/web host listening on http:\/\//.test(output)) resolve(); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (code && code !== 0) reject(new Error(`host exited ${code}: ${output}`)); });
  });
  await withTimeout(started, HOST_START_TIMEOUT_MS, "isolated host startup");
  return { url: `http://127.0.0.1:${port}/database`, output: () => output, close: () => closeChild(child) };
}

async function prepareFixture({ failureRetry = false } = {}) {
  const fixture = await createRecipeScrollFixture();
  const expected = expectedFixture();
  const recipeSchedule = new Map(expected.cards.filter((card) => card.type === "recipe").map((card) => [card.path, card.scheduled]));
  for (let index = 1; index <= 500; index += 1) {
    const number = String(index).padStart(3, "0");
    const relative = `recipes/visual-fixture-${number}.md`;
    const absolute = path.join(fixture.vaultRoot, relative);
    let markdown = await readFile(absolute, "utf8");
    markdown = markdown.replace(/^marked: .*$/m, "marked: false");
    const scheduled = recipeSchedule.get(relative);
    if (scheduled) markdown = markdown.replace(/^---\n\n/m, `scheduled: "${scheduled}"\n---\n\n`);
    await writeFile(absolute, markdown, "utf8");
  }
  await mkdir(path.join(fixture.vaultRoot, "planner"), { recursive: true });
  for (const card of expected.cards.filter((entry) => entry.type !== "recipe")) {
    const frontmatter = ["---", `title: "${card.title}"`, `type: "${card.type}"`];
    if (card.scheduled) frontmatter.push(`scheduled: "${card.scheduled}"`);
    if (card.marked) frontmatter.push("marked: true");
    frontmatter.push("---", "", `${card.title} deterministic transition fixture.`, "");
    await writeFile(path.join(fixture.vaultRoot, card.path), frontmatter.join("\n"), "utf8");
  }
  const blockedPath = failureRetry
    ? path.join(fixture.vaultRoot, "planner", "blocked-fixture.md")
    : null;
  if (blockedPath) {
    await writeFile(blockedPath, "---\ntitle: Blocked Fixture\ntype: unknown\n---\n", "utf8");
  }
  return { fixture, expected, blockedPath };
}

export function evaluateCollectedSample(raw, derived, expected, failure, failureRetry) {
  const postIdentityMatches = raw?.postWindow
    ? JSON.stringify(raw.postWindow.cardsByLane) === JSON.stringify(expected.lanes)
    : false;
  const consoleErrors = raw?.consoleErrors ?? [];
  const expectedFailureConsole = failureRetry
    && consoleErrors.length === 1
    && /Failed to load resource: the server responded with a status of 500/.test(consoleErrors[0]);
  const relevantConsoleErrors = expectedFailureConsole ? [] : consoleErrors;
  const networkErrors = raw?.networkErrors ?? [];
  const loadingTexts = raw?.postWindow?.loadingTexts ?? [];
  const withinLatencyBudgets = failureRetry || (
    derived.status === "OK"
    && derived.clickToPresentationMs <= CLICK_TO_PRESENTATION_BUDGET_MS
    && derived.pointerdownToPresentationMs <= POINTERDOWN_TO_PRESENTATION_BUDGET_MS
  );
  const passed = raw !== null
    && derived.status === "OK"
    && withinLatencyBudgets
    && !failure
    && relevantConsoleErrors.length === 0
    && networkErrors.length === 0
    && postIdentityMatches
    && loadingTexts.length === 0;
  let resolvedFailure = failure;
  if (!passed && !resolvedFailure) {
    if (derived.status !== "OK") resolvedFailure = derived.reason;
    else if (!withinLatencyBudgets) {
      resolvedFailure = `latency budget exceeded: click ${derived.clickToPresentationMs}ms / ${CLICK_TO_PRESENTATION_BUDGET_MS}ms, pointerdown ${derived.pointerdownToPresentationMs}ms / ${POINTERDOWN_TO_PRESENTATION_BUDGET_MS}ms`;
    } else if (relevantConsoleErrors.length || networkErrors.length) resolvedFailure = "relevant console/network errors";
    else if (!postIdentityMatches) resolvedFailure = "post-window board identity mismatch";
    else resolvedFailure = "post-window planner loading/error surface remains";
  }
  return { passed, failure: resolvedFailure };
}

async function runSample(index, helper, headless, earlyClick, failureRetry) {
  const { fixture, expected, blockedPath } = await prepareFixture({ failureRetry });
  if (failureRetry && blockedPath) await chmod(blockedPath, 0o000);
  let host;
  let context;
  let page;
  let raw = null;
  let derived = { status: "UNDERIVABLE", reason: "sample did not reach derivation" };
  let failure = null;
  const consoleErrors = [];
  const networkErrors = [];
  try {
    host = await startHost(fixture, helper);
    const profile = path.join(fixture.root, "browser-profile");
    context = await chromium.launchPersistentContext(profile, { headless, viewport: VIEWPORT });
    await context.addInitScript(`(${observerSetup.toString()})()`);
    if (failureRetry) {
      // Deterministic failure-path fixture: keep background idle work pending so the
      // trusted Planner press owns the refresh attempt that encounters EACCES.
      await context.addInitScript(() => {
        window.requestIdleCallback = () => 1;
        window.cancelIdleCallback = () => undefined;
      });
    }
    page = context.pages()[0] ?? await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    page.on("requestfailed", (request) => networkErrors.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
    await page.goto(host.url, { waitUntil: "domcontentloaded" });
    const plannerButton = page.getByRole("button", { name: "Planner", exact: true });
    // The icon is replaced by background App renders; use the stable label side of
    // the button so an 80 ms dwell cannot be cancelled by removal of the hit node.
    const box = await plannerButton.boundingBox();
    if (!box) throw new Error("Planner navigation button has no pre-window bounds");
    await page.evaluate((value) => window.__mepConfigurePlannerTransition(value), expected);
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    const precondition = earlyClick || failureRetry
      ? page.evaluate(() => window.__mepPlannerTransitionDatabaseReady)
      : Promise.all([
          page.evaluate(() => window.__mepPlannerTransitionDatabaseReady),
          page.evaluate(() => window.__mepPlannerTransitionDatasetReady),
        ]);
    await withTimeout(
      precondition,
      DEADLINE_MS,
      earlyClick || failureRetry
        ? "early database exact readiness"
        : "resident database and planner dataset readiness"
    );
    await page.mouse.down();
    await new Promise((resolve) => setTimeout(resolve, PRESS_DWELL_MS));
    await page.mouse.up();
    if (failureRetry) {
      await withTimeout(
        page.evaluate(() => window.__mepPlannerTransitionFailure),
        DEADLINE_MS,
        "planner failure evidence"
      );
      if (!blockedPath) throw new Error("failure fixture path is missing");
      await chmod(blockedPath, 0o644);
      const retryButton = page.getByRole("button", { name: "Retry planner data", exact: true });
      await retryButton.click();
    }
    await withTimeout(page.evaluate(() => window.__mepPlannerTransitionEndpoint), DEADLINE_MS, "planner exact presentation");
    raw = await page.evaluate(() => structuredClone(window.__mepPlannerTransition));
    raw.postWindow = await page.evaluate(() => ({
      laneIds: Array.from(document.querySelectorAll(".kanban-board")).map((lane) => lane.getAttribute("data-id")),
      cardsByLane: Array.from(document.querySelectorAll(".kanban-board")).map((lane) => ({
        id: lane.getAttribute("data-id"),
        cardIds: Array.from(lane.querySelectorAll(".kanban-item")).map((card) => card.getAttribute("data-eid")),
      })),
      loadingTexts: Array.from(document.querySelectorAll(".mep-loading")).map((node) => node.textContent),
    }));
    if (failureRetry) {
      const failures = raw.marks.filter((entry) => entry.name === "mep:planner:navigation-failed");
      const semantics = raw.marks.filter((entry) => entry.name === "mep:planner:semantic-ready");
      const placeholders = raw.elements.filter((entry) => PLACEHOLDER_IDS.includes(entry.identifier));
      const identity = semantics.length === 1 ? {
        presetId: semantics[0].detail?.presetId,
        weekStart: semantics[0].detail?.weekStart,
        weekEnd: semantics[0].detail?.weekEnd,
        lanes: semantics[0].detail?.lanes,
      } : null;
      const pointer = raw.gestures.find((entry) => entry.type === "pointerdown" && entry.isTrusted);
      derived = failures.length === 1
        && pointer
        && failures[0].startTime > pointer.timeStamp
        && Number.isInteger(failures[0].detail?.generation)
        && /EACCES|permission denied/i.test(failures[0].detail?.message ?? "")
        && identity !== null
        && sameIdentity(identity, expected)
        && placeholders.length === 0
        ? { status: "OK", failureGeneration: failures[0].detail.generation, retrySemanticTime: semantics[0].startTime }
        : { status: "UNDERIVABLE", reason: "failure/retry evidence is incomplete or incorrect" };
    } else {
      derived = deriveTransitionSample(raw, expected);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (!raw && page) {
      raw = await page.evaluate(() => window.__mepPlannerTransition ? structuredClone(window.__mepPlannerTransition) : null).catch(() => null);
      if (raw) derived = deriveTransitionSample(raw, expected);
    }
  } finally {
    if (raw) {
      raw.consoleErrors = consoleErrors;
      raw.networkErrors = networkErrors.filter((value) => !value.includes("/api/watch") || !value.includes("ERR_ABORTED"));
    }
    await context?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    await fixture.cleanup();
  }
  const verdict = evaluateCollectedSample(raw, derived, expected, failure, failureRetry);
  return { index, ...verdict, expected, raw, derived, hostOutputTail: host?.output() ?? "" };
}

export function parseArgs(argv) {
  const args = { runs: 3, output: null, headless: true, pairedSample: false, skipBuild: false, earlyClick: false, failureRetry: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--runs") args.runs = Number(argv[++index]);
    else if (argv[index] === "--output") args.output = argv[++index];
    else if (argv[index] === "--headed") args.headless = false;
    else if (argv[index] === "--paired-sample") args.pairedSample = true;
    else if (argv[index] === "--skip-build") args.skipBuild = true;
    else if (argv[index] === "--early-click") args.earlyClick = true;
    else if (argv[index] === "--failure-retry") args.failureRetry = true;
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (![3, 5].includes(args.runs) && !(args.pairedSample && args.runs === 1)) {
    throw new Error("--runs must be exactly 3 (pilot) or 5 (certification arm); paired orchestration owns its internal single sample");
  }
  if (!args.output) throw new Error("--output is required so raw evidence is durable");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.skipBuild) await execFileAsync("npm", ["run", "build"]);
  const helper = await findHelper();
  const samples = [];
  for (let index = 1; index <= args.runs; index += 1) {
    process.stderr.write(`[planner-transition] sample ${index}/${args.runs}\n`);
    try {
      samples.push(await runSample(index, helper, args.headless, args.earlyClick, args.failureRetry));
    } catch (error) {
      samples.push({ index, passed: false, failure: error instanceof Error ? error.message : String(error), raw: null });
    }
  }
  const output = {
    schemaVersion: 1,
    contract: {
      workload: args.failureRetry ? "failure-retry" : args.earlyClick ? "early-database" : "resident-database",
      pressDwellMs: PRESS_DWELL_MS,
      exactAuthority: "PerformanceElementTiming.renderTime",
      precondition: args.earlyClick || args.failureRetry
        ? "database-exact"
        : "database-exact+planner-dataset-ready",
      runs: args.runs,
    },
    createdAt: new Date().toISOString(),
    gitHead: (await execFileAsync("git", ["rev-parse", "HEAD"])).stdout.trim(),
    samples,
  };
  await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: path.resolve(args.output), results: samples.map((sample) => sample.derived ?? { status: "UNDERIVABLE", reason: sample.failure }) }, null, 2));
  if (samples.some((sample) => !sample.passed)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    if (error.raw) console.error(JSON.stringify({ derived: error.derived, raw: error.raw }, null, 2));
    process.exitCode = 1;
  });
}
