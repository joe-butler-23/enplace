#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { applyLatencyInstrumentation, instrumentationPlanSha256 } from "./perceived-latency-instrumentation.mjs";

const execFileAsync = promisify(execFile);
export const STIMULUS_DWELL_MS = 80;
export const OBSERVATION_DEADLINE_MS = 2500;
const DWELL_TOLERANCE_MS = 8;
const VIEWPORT = { width: 1440, height: 1000 };
export const INTERACTIONS = ["cold-database", "warm-database", "database-planner", "planner-drop", "shopping-check", "database-recipe"];

const fail = (reason) => ({ status: "UNDERIVABLE", reason });
const entriesAfter = (entries, field, value, time) =>
  (entries ?? []).filter((entry) => entry[field] === value && entry.presentationTime > time);

function oneTrusted(raw, type) {
  return (raw.gestures ?? []).filter((entry) => entry.type === type && entry.isTrusted);
}

export function deriveSample(raw, budget) {
  if (!raw || !budget) return fail("missing raw sample or budget");
  if (raw.frame !== "top" || raw.frameUrl !== raw.topUrl) return fail("cross-frame evidence");
  if (raw.interaction === "cold-database" || raw.interaction === "warm-database") {
    if (raw.navigation?.startTime !== 0 || !["navigate", "reload"].includes(raw.navigation?.type)) return fail("exact navigationStart evidence is missing");
    if (raw.interaction === "warm-database" && raw.cacheEvidence?.passed !== true) {
      return fail(raw.cacheEvidence?.reason ?? "warm browser-cache premise is unproved");
    }
    if (raw.interaction === "warm-database") {
      const serviceWorker = raw.precondition?.serviceWorker;
      if (serviceWorker?.ready !== true || serviceWorker?.controlled !== true || serviceWorker?.activeState !== "activated") return fail("warm service-worker precondition is missing or not activated/controlling");
      const primer = serviceWorker.warmPrimer;
      if (primer?.ready !== true || primer?.controlled !== true || primer?.activeState !== "activated") return fail("warm primer service-worker precondition is missing or not activated/controlling");
    }
    const semantics = (raw.marks ?? []).filter((entry) => entry.name === raw.expected.semanticMark && entry.startTime >= 0);
    if (semantics.length !== 1) return fail(`cold ${raw.expected.semanticMark} count ${semantics.length} !== 1`);
    const detail = semantics[0].detail ?? {};
    if (!Array.isArray(detail.firstFourPaths) || detail.firstFourPaths.length === 0 || new Set(detail.firstFourPaths).size !== detail.firstFourPaths.length) {
      return fail("database semantic identity is missing or ambiguous");
    }
    if (detail.firstFourPaths[0] !== raw.expected.recipePath) return fail("database semantic identity names the wrong first recipe");
    const presentations = entriesAfter(raw.elements, "identifier", raw.expected.recipePath, -1);
    if (presentations.length !== 1) return fail(`exact cold target presentation count ${presentations.length} !== 1`);
    const presentation = presentations[0];
    if (presentation.frame !== raw.frame || presentation.renderer !== raw.renderer) return fail("cross-frame or cross-renderer presentation evidence");
    const navigationStartToSemanticMs = semantics[0].startTime;
    const navigationStartToPresentationMs = presentation.presentationTime;
    const failures = [];
    if (navigationStartToSemanticMs > budget.navigationStartToSemanticMs) failures.push(`navigationStartToSemanticMs ${navigationStartToSemanticMs}ms > ${budget.navigationStartToSemanticMs}ms`);
    if (navigationStartToPresentationMs > budget.navigationStartToPresentationMs) failures.push(`navigationStartToPresentationMs ${navigationStartToPresentationMs}ms > ${budget.navigationStartToPresentationMs}ms`);
    return {
      status: "OK", source: "observer", state: raw.expected.state, data: "fixture",
      semanticTime: semantics[0].startTime, presentationTime: presentation.presentationTime,
      navigationStartToSemanticMs, navigationStartToPresentationMs,
      withinBudget: failures.length === 0, budgetFailures: failures,
    };
  }
  const pointerdowns = oneTrusted(raw, "pointerdown");
  const pointerups = oneTrusted(raw, "pointerup");
  const clicks = oneTrusted(raw, "click");
  if (pointerdowns.length !== 1) return fail(`trusted pointerdown count ${pointerdowns.length} !== 1`);
  if (pointerups.length !== 1) return fail(`trusted pointerup count ${pointerups.length} !== 1`);
  const pointerdown = pointerdowns[0];
  const pointerup = pointerups[0];
  const expectedReleaseTarget = raw.interaction === "planner-drop" ? raw.expected.activationTarget : raw.expected.gestureTarget;
  if (pointerdown.target !== raw.expected.gestureTarget || pointerup.target !== expectedReleaseTarget) {
    return fail("trusted press/release was bound to the wrong target");
  }
  if (pointerup.timeStamp < pointerdown.timeStamp || pointerup.timeStamp - pointerdown.timeStamp < STIMULUS_DWELL_MS - DWELL_TOLERANCE_MS) {
    return fail(`physical press dwell ${pointerup.timeStamp - pointerdown.timeStamp}ms is below tolerance`);
  }
  if (raw.interaction !== "planner-drop" && pointerup.timeStamp - pointerdown.timeStamp > STIMULUS_DWELL_MS + DWELL_TOLERANCE_MS) {
    return fail(`physical press dwell ${pointerup.timeStamp - pointerdown.timeStamp}ms exceeds tolerance`);
  }
  const serviceWorker = raw.precondition?.serviceWorker;
  if (serviceWorker?.ready !== true || serviceWorker?.controlled !== true || serviceWorker?.activeState !== "activated") {
    return fail("resident service-worker precondition is missing or not activated/controlling");
  }
  const activationType = raw.interaction === "planner-drop" ? "pointerup" : "click";
  let activations = activationType === "click" ? clicks : pointerups;
  if (raw.interaction === "shopping-check") {
    const physicalClicks = clicks.filter((entry) => entry.target === raw.expected.gestureTarget);
    activations = clicks.filter((entry) => entry.target === raw.expected.activationTarget);
    if (physicalClicks.length !== 1 || activations.length !== 1 || Math.abs(physicalClicks[0].timeStamp - activations[0].timeStamp) > 1) {
      return fail("shopping gesture lacks one same-timestamp physical click and input activation click");
    }
  } else if (activations.length !== 1) return fail(`trusted ${activationType} count ${activations.length} !== 1`);
  const activation = activations[0];
  if (activation.target !== raw.expected.activationTarget) return fail(`trusted ${activationType} was bound to the wrong target`);
  const matchingEvents = (raw.events ?? []).filter((entry) => entry.name === "pointerdown" && Math.abs(entry.startTime - pointerdown.timeStamp) <= 2);
  const matchingFirstInputs = (raw.firstInputs ?? []).filter((entry) => entry.name === "pointerdown" && Math.abs(entry.startTime - pointerdown.timeStamp) <= 2);
  if (matchingEvents.length > 1 || matchingFirstInputs.length > 1) return fail("ambiguous pointerdown EventTiming evidence");
  const pressEvent = matchingEvents[0] ?? matchingFirstInputs[0];
  if (!pressEvent) return fail("exact pointerdown EventTiming/first-input count 0 !== 1");
  if ((raw.firstInputs ?? []).length !== 1 || matchingFirstInputs.length !== 1) return fail("measured gesture is not the page first trusted input");
  if (matchingEvents[0] && matchingFirstInputs[0] && matchingEvents[0].interactionId !== matchingFirstInputs[0].interactionId) return fail("pointerdown EventTiming interactionId mismatch");
  const feedbackPresentation = pressEvent.startTime + pressEvent.duration;
  if (!(feedbackPresentation > pointerdown.timeStamp) || !(feedbackPresentation < pointerup.timeStamp)) {
    return fail("press-feedback presentation is not ordered between trusted pointerdown and release");
  }

  const markName = raw.expected.semanticMark;
  const semantics = (raw.marks ?? []).filter((entry) => entry.name === markName && entry.startTime > activation.timeStamp);
  if (semantics.length !== 1) return fail(`post-${activationType} ${markName} count ${semantics.length} !== 1`);
  const semantic = semantics[0];
  const detail = semantic.detail ?? {};
  let targetIdentifier = raw.expected.presentationIdentifier;

  if (raw.interaction === "database-planner") {
    if (!Number.isInteger(detail.generation) || detail.generation <= 0 || detail.presetId !== "weekly" || !Array.isArray(detail.lanes)) {
      return fail("planner semantic identity is missing or invalid");
    }
    const markedLane = detail.lanes.find((lane) => lane.id === "marked");
    if (!markedLane?.cardIds?.includes(raw.expected.anchorEntryId)) return fail("planner semantic identity lacks the exact anchor card");
  } else if (raw.interaction === "planner-drop") {
    if (detail.itemId !== raw.expected.itemId || detail.targetLaneId !== raw.expected.targetLaneId || detail.targetEntryId !== raw.expected.targetEntryId || !Number.isInteger(detail.generation)) {
      return fail("planner drop semantic identity does not contain the exact settled operation");
    }
    targetIdentifier = detail.presentationIdentifier;
  } else if (raw.interaction === "shopping-check") {
    if (detail.itemId !== raw.expected.itemId || detail.checked !== true || !Number.isInteger(detail.generation)) {
      return fail("shopping check-off semantic evidence is missing the exact persisted item state");
    }
    targetIdentifier = detail.presentationIdentifier;
  } else if (raw.interaction === "database-recipe") {
    if (detail.path !== raw.expected.recipePath || detail.mode !== "full" || !detail.heroIdentifier) {
      return fail("recipe semantic identity is wrong or has no exact hero target");
    }
    targetIdentifier = detail.heroIdentifier;
  }

  const targetIdentifiers = raw.expected.presentationIdentifiers ?? (targetIdentifier ? [targetIdentifier] : []);
  if (targetIdentifiers.length === 0) return fail("exact target presentation identifier is missing");
  const presentations = [];
  for (const identifier of targetIdentifiers) {
    const matches = entriesAfter(raw.elements, "identifier", identifier, activation.timeStamp);
    if (matches.length !== 1) return fail(`exact target ${identifier} presentation count ${matches.length} !== 1`);
    presentations.push(matches[0]);
  }
  if (presentations.some((entry) => entry.frame !== raw.frame || entry.renderer !== raw.renderer)) return fail("cross-frame or cross-renderer presentation evidence");
  const presentation = presentations.reduce((latest, entry) => entry.presentationTime > latest.presentationTime ? entry : latest);
  if (!(presentation.presentationTime > activation.timeStamp)) return fail("exact target presentation did not follow activation");
  const click = clicks[0] ?? null;
  const values = {
    pointerdownToPresentationMs: presentation.presentationTime - pointerdown.timeStamp,
    releaseToPresentationMs: presentation.presentationTime - pointerup.timeStamp,
    ...(click ? { clickToPresentationMs: presentation.presentationTime - click.timeStamp } : {}),
  };
  const exceeded = Object.entries(budget).filter(([key, limit]) => key.endsWith("Ms") && values[key] > limit);
  return {
    status: "OK",
    source: "observer",
    state: raw.expected.state,
    data: "fixture",
    semanticTime: semantic.startTime,
    feedbackPresentationTime: feedbackPresentation,
    presentationTime: presentation.presentationTime,
    pressDwellMs: pointerup.timeStamp - pointerdown.timeStamp,
    ...values,
    withinBudget: exceeded.length === 0,
    budgetFailures: exceeded.map(([key, limit]) => `${key} ${values[key]}ms > ${limit}ms`),
  };
}

export function evaluateSample(raw, budget) {
  const derived = deriveSample(raw, budget);
  if (derived.status !== "OK") return { passed: false, derived, failure: derived.reason };
  if (raw.correctness?.passed !== true) return { passed: false, derived, failure: raw.correctness?.reason ?? "post-window correctness failed" };
  if (!Array.isArray(raw.consoleErrors) || !Array.isArray(raw.pageErrors)) return { passed: false, derived, failure: "console or page error evidence missing" };
  if (raw.consoleErrors.length || raw.pageErrors.length) return { passed: false, derived, failure: "console or page errors" };
  if (!derived.withinBudget) return { passed: false, derived, failure: derived.budgetFailures.join("; ") };
  return { passed: true, derived, failure: null };
}

export const COMPARISON_POLICY_VERSION = "candidate-direct-control-comparable-v1";

export function isComparableSample(sample) {
  const derived = sample?.derived;
  const cleanPass = sample?.passed === true && sample?.failure === null && derived?.withinBudget === true;
  const exactBudgetFailure = sample?.passed === false && derived?.withinBudget === false
    && Array.isArray(derived.budgetFailures) && derived.budgetFailures.length > 0
    && sample?.failure === derived.budgetFailures.join("; ");
  return derived?.status === "OK"
    && sample?.raw?.correctness?.passed === true
    && Array.isArray(sample.raw.consoleErrors)
    && sample.raw.consoleErrors.length === 0
    && Array.isArray(sample.raw.pageErrors)
    && sample.raw.pageErrors.length === 0
    && (cleanPass || exactBudgetFailure);
}

export function evaluateComparison(samples) {
  const candidate = samples.filter((sample) => sample.variant === "candidate");
  const control = samples.filter((sample) => sample.variant === "control");
  const candidatePassed = candidate.length > 0 && candidate.every((sample) => sample.passed === true && isComparableSample(sample));
  const controlComparable = control.length > 0 && control.every((sample) => sample.comparable === true && isComparableSample(sample));
  return { candidatePassed, controlComparable, passed: candidatePassed && controlComparable };
}

export function evaluateRun(samples, phase, variant) {
  if (phase !== "preflight") return evaluateComparison(samples);
  const candidatePassed = variant === "candidate" && samples.length > 0 && samples.every((sample) => sample.passed === true && isComparableSample(sample));
  const controlComparable = variant === "control" && samples.length > 0 && samples.every((sample) => sample.comparable === true && isComparableSample(sample));
  return { candidatePassed, controlComparable, passed: variant === "candidate" ? candidatePassed : controlComparable };
}

export function parseArgs(argv) {
  const args = { phase: "pilot", pairs: 3, output: null, control: "cbd87b0", candidate: "da40c62", headed: false, pilotArtifact: null, only: null, variant: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--phase") args.phase = argv[++index];
    else if (value === "--pairs") args.pairs = Number(argv[++index]);
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--control") args.control = argv[++index];
    else if (value === "--candidate") args.candidate = argv[++index];
    else if (value === "--pilot-artifact") args.pilotArtifact = argv[++index];
    else if (value === "--only") args.only = argv[++index];
    else if (value === "--variant") args.variant = argv[++index];
    else if (value === "--headed") args.headed = true;
    else throw new Error(`unknown argument ${value}`);
  }
  if (!args.output || !path.isAbsolute(args.output)) throw new Error("--output must be an absolute path outside git");
  if (args.phase === "pilot" && args.pairs !== 3) throw new Error("pilot must contain exactly 3 interleaved pairs");
  if (args.phase === "preflight" && (args.pairs !== 1 || !INTERACTIONS.includes(args.only) || !["control", "candidate"].includes(args.variant))) {
    throw new Error("preflight requires --pairs 1, one valid --only lane, and --variant control|candidate");
  }
  if (args.phase === "certification" && (args.pairs !== 10 || !args.pilotArtifact)) {
    throw new Error("certification requires exactly 10 pairs and --pilot-artifact");
  }
  if (!["preflight", "pilot", "certification"].includes(args.phase)) throw new Error("--phase must be preflight, pilot, or certification");
  return args;
}

function observerSetup() {
  const evidence = { arm: null, gestures: [], marks: [], elements: [], events: [], firstInputs: [], targets: new WeakMap(), renderer: crypto.randomUUID() };
  const serialise = (entry) => ({
    name: entry.name, identifier: entry.identifier || "", startTime: entry.startTime,
    presentationTime: Number(entry.renderTime || 0), detail: entry.detail,
    frame: "top", renderer: evidence.renderer,
  });
  const targetName = (event) => {
    for (const candidate of event.composedPath()) {
      const label = candidate instanceof Element ? evidence.targets.get(candidate) : null;
      if (label) return label;
    }
    return "unknown";
  };
  window.__mepLatencyBind = (element, label) => { evidence.targets.set(element, label); };
  const signal = () => {
    if (!evidence.arm) return;
    const navigation = evidence.arm.interaction === "cold-database" || evidence.arm.interaction === "warm-database";
    const activationType = evidence.arm.interaction === "planner-drop" ? "pointerup" : "click";
    const activation = navigation ? { timeStamp: -1 } : evidence.gestures.find((entry) => entry.type === activationType && entry.timeStamp > evidence.arm.time);
    if (!activation) return;
    const marks = evidence.marks.filter((entry) => entry.name === evidence.arm.expected.semanticMark && entry.startTime > activation.timeStamp);
    const identifiers = new Set(evidence.elements.filter((entry) => entry.presentationTime > activation.timeStamp).map((entry) => entry.identifier));
    const detail = marks[0]?.detail ?? {};
    let id = evidence.arm.expected.presentationIdentifier;
    if (evidence.arm.interaction === "cold-database" || evidence.arm.interaction === "warm-database") id = detail.firstFourPaths?.[0];
    if (evidence.arm.interaction === "database-recipe") id = detail.heroIdentifier;
    if (evidence.arm.interaction === "shopping-check") id = detail.presentationIdentifier;
    const requiredIds = evidence.arm.expected.presentationIdentifiers ?? (id ? [id] : []);
    if (marks.length > 0 && requiredIds.length > 0 && requiredIds.every((identifier) => identifiers.has(identifier))) evidence.arm.resolve("evidence");
  };
  for (const type of ["pointerdown", "pointerup", "click"]) {
    addEventListener(type, (event) => {
      if (!evidence.arm || !event.isTrusted || event.timeStamp <= evidence.arm.time) return;
      evidence.gestures.push({ type, timeStamp: event.timeStamp, isTrusted: true, button: event.button, target: targetName(event) });
      signal();
    }, true);
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) evidence.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, interactionId: entry.interactionId });
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch (error) { evidence.observerError = String(error); }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) evidence.firstInputs.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration, interactionId: entry.interactionId });
    }).observe({ type: "first-input", buffered: true });
  } catch (error) { evidence.observerError = String(error); }
  for (const type of ["mark", "element"]) {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) (type === "mark" ? evidence.marks : evidence.elements).push(serialise(entry));
        signal();
      }).observe({ type, buffered: true });
    } catch (error) { evidence.observerError = String(error); }
  }
  window.__mepLatencyArm = (interaction, expected, deadlineMs, explicitStart) => {
    if (evidence.arm) return evidence.arm.promise;
    const time = explicitStart ?? performance.now();
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    evidence.arm = { interaction, expected, time, resolve, promise: null };
    const bounded = promise.finally(() => clearTimeout(timer));
    evidence.arm.promise = bounded;
    const timer = setTimeout(() => resolve("deadline"), deadlineMs);
    signal();
    return bounded;
  };
  window.__mepLatencyRead = () => ({
    frame: window === window.top ? "top" : "child", frameUrl: location.href, topUrl: top.location.href,
    renderer: evidence.renderer, interaction: evidence.arm?.interaction, expected: evidence.arm?.expected,
    gestures: evidence.gestures.filter((entry) => entry.timeStamp > evidence.arm.time),
    events: evidence.events.filter((entry) => entry.startTime > evidence.arm.time),
    firstInputs: evidence.firstInputs.filter((entry) => entry.startTime > evidence.arm.time),
    marks: evidence.marks.filter((entry) => entry.startTime >= evidence.arm.time),
    elements: evidence.elements.filter((entry) => entry.presentationTime >= evidence.arm.time),
    observerError: evidence.observerError ?? null,
  });
  const latencyParams = new URLSearchParams(location.search);
  const databaseState = latencyParams.has("latency-cold") ? "cold" : latencyParams.has("latency-warm") ? "warm" : null;
  if (databaseState) {
    window.__mepLatencyArm(`${databaseState}-database`, {
      state: databaseState, semanticMark: "mep:database:semantic-ready",
      recipePath: "banana-oat-loaf.md"
    }, 2500, 0);
  }
}

async function dwellFrom(stimulusStartedAt) {
  const remaining = Math.max(0, STIMULUS_DWELL_MS - (performance.now() - stimulusStartedAt));
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
async function press(page, locator, label) {
  await locator.evaluate((element, targetLabel) => window.__mepLatencyBind(element, targetLabel), label);
  const box = await locator.boundingBox();
  if (!box) throw new Error("gesture target has no bounds");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const stimulusStartedAt = performance.now();
  await page.mouse.down(); await dwellFrom(stimulusStartedAt); await page.mouse.up();
}
async function arm(page, interaction, expected) {
  return page.evaluate(({ interaction, expected, deadline }) => window.__mepLatencyArm(interaction, expected, deadline),
    { interaction, expected, deadline: OBSERVATION_DEADLINE_MS });
}
async function ensureResidentServiceWorker(page) {
  let state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { ready: true, controlled: Boolean(navigator.serviceWorker.controller), activeState: registration.active?.state ?? null, scriptURL: registration.active?.scriptURL ?? null };
  });
  if (!state.controlled) {
    await page.reload({ waitUntil: "domcontentloaded" });
    state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return { ready: true, controlled: Boolean(navigator.serviceWorker.controller), activeState: registration.active?.state ?? null, scriptURL: registration.active?.scriptURL ?? null };
    });
  }
  if (!state.ready || !state.controlled || state.activeState !== "activated") throw new Error("service worker did not become activated and controlling");
  return state;
}

async function bootSeededKitchen(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByText("11 recipes", { exact: true }).waitFor();
  const serviceWorker = await ensureResidentServiceWorker(page);
  await page.getByText("11 recipes", { exact: true }).waitFor();
  return serviceWorker;
}
async function bootKitchenWithFiles(page, baseUrl, files) {
  // Seed the sample kitchen, then add fixture files through the Settings import, which is
  // the same path a person uses; every click here is programmatic so the measured gesture
  // stays the page's first trusted input.
  await bootSeededKitchen(page, baseUrl);
  await page.getByRole("button", { name: "Settings", exact: true }).evaluate((element) => element.click());
  const input = page.locator('input[type="file"][multiple]').first();
  await input.waitFor({ state: "attached" });
  await input.setInputFiles(Object.entries(files).map(([name, text]) => ({ name, mimeType: "text/markdown", buffer: Buffer.from(text) })));
  await page.getByText(/^Imported \d+ file/).waitFor();
  await page.locator(".mep-dialog__close").first().evaluate((element) => element.click());
  await page.getByRole("button", { name: "Shopping List", exact: true }).waitFor();
  const serviceWorker = await ensureResidentServiceWorker(page);
  await page.getByRole("button", { name: "Shopping List", exact: true }).waitFor();
  return serviceWorker;
}

async function markAndOpenPlanner(page, baseUrl) {
  const serviceWorker = await bootSeededKitchen(page, baseUrl);
  const marked = page.getByRole("checkbox", { name: "Marked" }).first();
  await marked.evaluate((element) => element.click());
  await page.waitForFunction((input) => input.checked === true && input.disabled === false, await marked.elementHandle());
  const planner = page.getByRole("button", { name: "Planner", exact: true });
  await planner.evaluate((element) => element.click());
  await page.locator('.kanban-board[data-id="marked"] .kanban-item').first().waitFor();
  return serviceWorker;
}
async function drag(page, source, target, sourceLabel, targetLabel) {
  await source.evaluate((element, label) => window.__mepLatencyBind(element, label), sourceLabel);
  await target.evaluate((element, label) => window.__mepLatencyBind(element, label), targetLabel);
  const from = await source.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error("drag target has no bounds");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down(); await new Promise((resolve) => setTimeout(resolve, STIMULUS_DWELL_MS));
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(24, to.height / 2), { steps: 8 });
  await page.mouse.up();
}

async function collectInteraction(browser, baseUrl, interaction, budget) {
  // Every sample gets a fresh profile and lets the app seed its kitchen. Warm navigation
  // primes and then reuses this same profile, service worker, and kitchen.
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(`(${observerSetup.toString()})()`);
  const page = await context.newPage();
  const consoleErrors = []; const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  let expected; let wait; let residentPrecondition = null; let correctness = { passed: false, reason: "sample did not reach correctness" };
  try {
    if (interaction === "cold-database") {
      await page.goto(`${baseUrl}?latency-cold`, { waitUntil: "domcontentloaded" });
      expected = { state: "cold", semanticMark: "mep:database:semantic-ready", recipePath: "banana-oat-loaf.md" };
      wait = page.evaluate(() => window.__mepLatencyArm("cold-database", window.__mepLatencyRead().expected, 2500, 0));
      await wait;
      correctness = { passed: await page.getByText("11 recipes", { exact: true }).isVisible(), reason: "database recipe count is incorrect" };
    } else if (interaction === "warm-database") {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.getByText("11 recipes", { exact: true }).waitFor();
      const warmPrimerPrecondition = await ensureResidentServiceWorker(page);
      await page.getByText("11 recipes", { exact: true }).waitFor();
      await page.goto(`${baseUrl}?latency-warm`, { waitUntil: "domcontentloaded" });
      residentPrecondition = await ensureResidentServiceWorker(page);
      residentPrecondition.warmPrimer = warmPrimerPrecondition;
      expected = { state: "warm", semanticMark: "mep:database:semantic-ready", recipePath: "banana-oat-loaf.md" };
      wait = page.evaluate(() => window.__mepLatencyArm("warm-database", window.__mepLatencyRead().expected, 2500, 0));
      await wait;
      correctness = { passed: await page.getByText("11 recipes", { exact: true }).isVisible(), reason: "warm database recipe count is incorrect" };
    } else if (interaction === "database-planner") {
      residentPrecondition = await bootSeededKitchen(page, baseUrl);
      const marked = page.getByRole("checkbox", { name: "Marked" }).first();
      await marked.evaluate((element) => element.click());
      await page.waitForFunction((input) => input.checked === true && input.disabled === false, await marked.elementHandle());
      const target = page.getByRole("button", { name: "Planner", exact: true });
      const anchorEntryId = "banana-oat-loaf.md::marked";
      expected = { state: "resident", semanticMark: "mep:planner:semantic-ready", anchorEntryId, presentationIdentifiers: ["mep:planner-week-range", `mep:planner-card-title:${anchorEntryId}`], gestureTarget: "button:Planner", activationTarget: "button:Planner" };
      wait = arm(page, interaction, expected); await press(page, target, expected.gestureTarget); await wait;
      const exactWeek = page.locator('[elementtiming="mep:planner-week-range"]');
      const exactCard = page.locator(`[data-eid="${anchorEntryId}"]`);
      correctness = { passed: await exactWeek.isVisible() && await exactCard.isVisible(), reason: "exact Planner week/card identity did not land" };
    } else if (interaction === "planner-drop") {
      residentPrecondition = await markAndOpenPlanner(page, baseUrl);
      const source = page.locator('.kanban-board[data-id="marked"] .kanban-item').first();
      const pathValue = (await source.getAttribute("data-eid")).split("::")[0];
      const lane = page.locator('.kanban-board:not([data-id="marked"])').first();
      const targetLaneId = await lane.getAttribute("data-id");
      const sourceId = await source.getAttribute("data-eid");
      expected = { state: "resident", semanticMark: "mep:planner:drop-settled", itemId: pathValue, targetLaneId, targetEntryId: `${pathValue}::${targetLaneId}`, presentationIdentifier: `mep:planner-card-title:${pathValue}::${targetLaneId}`, gestureTarget: `planner-card:${sourceId}`, activationTarget: `planner-card:${sourceId}` };
      await lane.evaluate((element, label) => window.__mepLatencyBind(element, label), expected.activationTarget);
      wait = arm(page, interaction, expected); await drag(page, source, lane.locator(".kanban-drag"), expected.gestureTarget, expected.activationTarget); await wait;
      correctness = { passed: await lane.getByText("Banana oat loaf", { exact: true }).isVisible(), reason: "moved card is absent from exact target lane" };
    } else if (interaction === "shopping-check") {
      residentPrecondition = await bootKitchenWithFiles(page, baseUrl, { "Shopping.md": "## Fruit\n- [ ] 3 ripe bananas\n" });
      const shopping = page.getByRole("button", { name: "Shopping List", exact: true });
      await shopping.evaluate((element) => element.click());
      const checkbox = page.getByRole("checkbox", { name: "3 ripe bananas" }); await checkbox.waitFor();
      const labelTarget = page.locator(".shopping-item__box").first();
      expected = { state: "resident", semanticMark: "mep:shopping:check-settled", itemId: await checkbox.getAttribute("data-item-id"), gestureTarget: "shopping-box:3 ripe bananas", activationTarget: "shopping-input:3 ripe bananas" };
      await checkbox.evaluate((element, label) => window.__mepLatencyBind(element, label), expected.activationTarget);
      wait = arm(page, interaction, expected); await press(page, labelTarget, expected.gestureTarget); await wait;
      correctness = { passed: await checkbox.isChecked(), reason: "shopping item is not checked" };
    } else if (interaction === "database-recipe") {
      residentPrecondition = await bootSeededKitchen(page, baseUrl);
      const target = page.getByRole("button", { name: "Open recipe Banana oat loaf" });
      expected = { state: "resident", semanticMark: "mep:recipe:semantic-ready", recipePath: "banana-oat-loaf.md", gestureTarget: "button:Open recipe Banana oat loaf", activationTarget: "button:Open recipe Banana oat loaf" };
      wait = arm(page, interaction, expected); await press(page, target, expected.gestureTarget); await wait;
      correctness = { passed: await page.getByRole("heading", { name: "Banana oat loaf", exact: true }).isVisible(), reason: "wrong recipe landed" };
    } else throw new Error(`unknown interaction ${interaction}`);
    const raw = await page.evaluate(() => window.__mepLatencyRead());
    if (residentPrecondition) raw.precondition = { serviceWorker: residentPrecondition };
    if (interaction === "cold-database" || interaction === "warm-database") {
      raw.navigation = await page.evaluate(() => {
        const entry = performance.getEntriesByType("navigation")[0];
        return entry ? { startTime: entry.startTime, type: entry.type, timeOrigin: performance.timeOrigin } : null;
      });
      raw.cacheEvidence = await page.evaluate((expectedState) => {
        const entries = performance.getEntriesByType("resource")
          .filter((entry) => entry.name.startsWith(location.origin) && entry.name.includes("/assets/"))
          .map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize }));
        const cacheHits = entries.filter((entry) => entry.transferSize === 0 && entry.decodedBodySize > 0);
        const sampleHits = cacheHits.filter((entry) => /banana-oat-loaf|\.(md|webp)(?:$|\?)/.test(entry.name));
        const transferred = entries.filter((entry) => entry.transferSize > 0);
        // Warm means nothing crossed the network: every app asset came from the service
        // worker or HTTP cache. The sample pack lives in the kitchen's IndexedDB after the
        // first visit, so no sample asset is requested at all on a warm visit.
        const passed = expectedState !== "warm" || (entries.length > 0 && transferred.length === 0);
        return {
          expectedState,
          passed,
          reason: passed ? null : `warm cache unproved: ${cacheHits.length}/${entries.length} assets were cache hits; ${sampleHits.length} sample hits; ${transferred.length} network transfers (${transferred.map((entry) => entry.name.split("/").pop()).join(", ")})`,
          assetCount: entries.length,
          cacheHitCount: cacheHits.length,
          sampleCacheHitCount: sampleHits.length,
          networkTransferCount: transferred.length,
          entries,
        };
      }, expected.state);
    }
    raw.correctness = correctness; raw.consoleErrors = consoleErrors; raw.pageErrors = pageErrors;
    return { raw, ...evaluateSample(raw, budget) };
  } catch (error) {
    const raw = await page.evaluate(() => window.__mepLatencyRead?.() ?? null).catch(() => null);
    if (raw) {
      raw.correctness = correctness; raw.consoleErrors = consoleErrors; raw.pageErrors = pageErrors;
    }
    const derived = raw ? deriveSample(raw, budget) : fail("sample produced no raw evidence");
    return { raw, derived, passed: false, failure: error instanceof Error ? error.message : String(error) };
  } finally { await context.close(); }
}

function contentType(filename) {
  if (filename.endsWith(".html")) return "text/html"; if (filename.endsWith(".js")) return "text/javascript";
  if (filename.endsWith(".css")) return "text/css"; if (filename.endsWith(".json") || filename.endsWith(".webmanifest")) return "application/json";
  if (filename.endsWith(".png")) return "image/png"; if (filename.endsWith(".webp")) return "image/webp"; return "application/octet-stream";
}
async function serve(root) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      let filename = path.join(root, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      if (url.pathname === "/" || !path.extname(filename)) filename = path.join(root, "index.html");
      const body = await readFile(filename); response.writeHead(200, { "content-type": contentType(filename), "cache-control": filename.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" }); response.end(body);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}
async function prepareBuild(ref, label, root) {
  const source = path.join(root, label); const dist = path.join(root, `${label}-dist`); await mkdir(source, { recursive: true });
  await new Promise((resolve, reject) => {
    const archive = spawn("git", ["archive", ref], { stdio: ["ignore", "pipe", "inherit"] });
    const extract = spawn("tar", ["-x", "-C", source], { stdio: [archive.stdout, "inherit", "inherit"] });
    archive.once("error", reject); extract.once("error", reject); extract.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
  });
  const instrumentation = await applyLatencyInstrumentation(source);
  await execFileAsync("npm", ["ci", "--ignore-scripts"], { cwd: source });
  await execFileAsync("npm", ["run", "build", "--", "--outDir", dist], { cwd: source });
  return { source, dist, instrumentation, ref: (await execFileAsync("git", ["rev-parse", ref])).stdout.trim() };
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b); const pick = (p) => sorted[Math.ceil(sorted.length * p) - 1] ?? null;
  return { count: values.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? null };
}

const canonical = (value) => JSON.stringify(value);

export function validatePilotAdmission(pilot, expected) {
  const errors = [];
  if (pilot?.phase !== "pilot") errors.push("phase is not pilot");
  if (pilot?.pairs !== 3) errors.push("pilot pairs is not 3");
  if (pilot?.passed !== true) errors.push("comparison pilot passed is not true");
  if (pilot?.candidatePassed !== true) errors.push("candidate direct gate is not true");
  if (pilot?.controlComparable !== true) errors.push("control comparability gate is not true");
  if (!Array.isArray(pilot?.samples) || pilot.samples.length !== 36) errors.push("pilot must contain exactly 36 samples");
  if (pilot?.contract?.control !== expected.control) errors.push("control ref mismatch");
  if (pilot?.contract?.candidate !== expected.candidate) errors.push("candidate ref mismatch");
  if (canonical(pilot?.contract?.anchors) !== canonical(expected.anchors)) errors.push("anchor contract mismatch");
  if (pilot?.contract?.instrumentationPlanSha256 !== expected.instrumentationPlanSha256) errors.push("instrumentation plan digest mismatch");
  if (pilot?.contract?.comparisonPolicyVersion !== expected.comparisonPolicyVersion) errors.push("comparison policy mismatch");
  const keys = new Set();
  for (const sample of Array.isArray(pilot?.samples) ? pilot.samples : []) {
    const key = `${sample.pair}:${sample.variant}:${sample.interaction}`;
    if (keys.has(key)) errors.push(`duplicate coverage ${key}`);
    keys.add(key);
    const budget = expected.anchors?.[sample.interaction];
    if (!budget || sample.raw?.interaction !== sample.interaction) {
      errors.push(`raw interaction or budget mismatch ${key}`);
      continue;
    }
    const recomputed = evaluateSample(sample.raw, budget);
    const comparable = isComparableSample({ raw: sample.raw, ...recomputed });
    if (sample.passed !== recomputed.passed || sample.failure !== recomputed.failure
      || canonical(sample.derived) !== canonical(recomputed.derived) || sample.comparable !== comparable) {
      errors.push(`serialized verdict mismatch ${key}`);
    }
    if (sample.variant === "candidate" && recomputed.passed !== true) errors.push(`failed candidate sample ${key}`);
    if (sample.variant === "control" && !comparable) errors.push(`invalid control comparator ${key}`);
  }
  for (let pair = 1; pair <= 3; pair += 1) for (const variant of ["control", "candidate"]) for (const interaction of INTERACTIONS) {
    const key = `${pair}:${variant}:${interaction}`;
    if (!keys.has(key)) errors.push(`missing coverage ${key}`);
  }
  if (keys.size !== 36) errors.push(`unique coverage ${keys.size} !== 36`);
  return [...new Set(errors)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const budgets = JSON.parse(await readFile(new URL("./perceived-latency-budgets.json", import.meta.url), "utf8"));
  const resolvedRefs = {
    control: (await execFileAsync("git", ["rev-parse", args.control])).stdout.trim(),
    candidate: (await execFileAsync("git", ["rev-parse", args.candidate])).stdout.trim(),
  };
  if (args.phase === "certification") {
    const pilot = JSON.parse(await readFile(args.pilotArtifact, "utf8"));
    const admissionErrors = validatePilotAdmission(pilot, {
      ...resolvedRefs,
      anchors: budgets.interactions,
      instrumentationPlanSha256,
      comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    });
    if (admissionErrors.length) throw new Error(`STOP: pilot admission failed: ${admissionErrors.join("; ")}`);
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "mep-latency-builds-"));
  let browser; const servers = [];
  try {
    const control = await prepareBuild(resolvedRefs.control, "control", scratch); const candidate = await prepareBuild(resolvedRefs.candidate, "candidate", scratch);
    if (control.instrumentation.planSha256 !== instrumentationPlanSha256 || candidate.instrumentation.planSha256 !== instrumentationPlanSha256) {
      throw new Error("instrumentation plan digest mismatch between builds");
    }
    const controlServer = await serve(control.dist); const candidateServer = await serve(candidate.dist); servers.push(controlServer, candidateServer);
    browser = await chromium.launch({ headless: !args.headed });
    const samples = [];
    const plannedInteractions = args.phase === "preflight" ? [args.only] : INTERACTIONS;
    for (let pair = 1; pair <= args.pairs; pair += 1) {
      const interleavedArms = pair % 2 ? [["control", controlServer.url], ["candidate", candidateServer.url]] : [["candidate", candidateServer.url], ["control", controlServer.url]];
      const arms = args.phase === "preflight" ? interleavedArms.filter(([variant]) => variant === args.variant) : interleavedArms;
      for (const interaction of plannedInteractions) for (const [variant, url] of arms) {
        process.stderr.write(`[latency] pair ${pair}/${args.pairs} ${interaction} ${variant}\n`);
        const sample = await collectInteraction(browser, url, interaction, budgets.interactions[interaction]);
        samples.push({ pair, variant, interaction, ...sample, comparable: isComparableSample(sample) });
      }
    }
    const descriptive = {};
    for (const interaction of plannedInteractions) for (const variant of ["control", "candidate"]) {
      const values = samples.filter((sample) => sample.interaction === interaction && sample.variant === variant && sample.derived.status === "OK")
        .map((sample) => sample.derived.clickToPresentationMs ?? sample.derived.releaseToPresentationMs ?? sample.derived.navigationStartToPresentationMs ?? sample.derived.pointerdownToPresentationMs);
      descriptive[`${interaction}:${variant}`] = stats(values);
    }
    const comparison = evaluateRun(samples, args.phase, args.variant);
    const artifact = { schemaVersion: 1, phase: args.phase, pairs: args.pairs, createdAt: new Date().toISOString(),
      contract: { control: control.ref, candidate: candidate.ref, boundaryEvents: "trusted pointerdown, pointerup, and click (release for drag)", conditionMeasured: "each sample starts in a fresh extension-free Chromium profile and seeded kitchen; warm navigation reuses that profile and kitchen", sampleCount: `${args.pairs} candidate certification samples and ${args.pairs} control comparison samples per interaction`, comparisonPolicyVersion: COMPARISON_POLICY_VERSION, comparisonPolicy: "candidate samples must meet every direct budget; historical control samples must remain correct and exactly derivable but may exceed candidate budgets", anchors: budgets.interactions, authorities: { navigationStart: "PerformanceNavigationTiming.timeOrigin-relative navigationStart (0)", pressFeedback: "exact-target buffered PerformanceEventTiming pointerdown startTime+duration, ordered before release", targetCompletion: "exact buffered PerformanceElementTiming.renderTime; no fallback" }, stimulusDwellMs: STIMULUS_DWELL_MS, observationDeadlineMs: OBSERVATION_DEADLINE_MS, source: "observer", instrumentationPlanSha256, instrumentation: { control: control.instrumentation, candidate: candidate.instrumentation } },
      browser: { engine: "chromium", version: browser.version(), executablePath: chromium.executablePath(), playwrightVersion: JSON.parse(await readFile(new URL("../node_modules/@playwright/test/package.json", import.meta.url), "utf8")).version, node: process.version, platform: process.platform, arch: process.arch, profile: "fresh non-persistent context and seeded kitchen per sample; warm navigation reuses its sample profile" },
      samples, descriptive, candidatePassed: comparison.candidatePassed, controlComparable: comparison.controlComparable, passed: comparison.passed };
    await mkdir(path.dirname(args.output), { recursive: true }); await writeFile(args.output, `${JSON.stringify(artifact, null, 2)}
`);
    console.log(JSON.stringify({ output: args.output, passed: artifact.passed, candidatePassed: artifact.candidatePassed, controlComparable: artifact.controlComparable, samples: samples.map(({ pair, variant, interaction, passed, comparable, failure, derived }) => ({ pair, variant, interaction, passed, comparable, failure, derived })) }, null, 2));
    if (!artifact.passed) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined); for (const server of servers) await server.close(); await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error); process.exitCode = 1; });
