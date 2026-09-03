import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { COMPARISON_POLICY_VERSION, deriveSample, evaluateComparison, evaluateRun, evaluateSample, isComparableSample, parseArgs, validatePilotAdmission, INTERACTIONS } from "./benchmark-perceived-latency.mjs";
import { classifyInstrumentationState, instrumentationPlanSha256 } from "./perceived-latency-instrumentation.mjs";

const budget = { clickToPresentationMs: 50, pointerdownToPresentationMs: 130 };
const admissionRaws = JSON.parse(await readFile(new URL("./fixtures/perceived-latency-admission.json", import.meta.url), "utf8"));
const admissionAnchors = JSON.parse(await readFile(new URL("./perceived-latency-budgets.json", import.meta.url), "utf8")).interactions;

function plannerRaw({ semanticTime = 190, presentationTime = 200 } = {}) {
  return {
    frame: "top", frameUrl: "http://fixture/planner", topUrl: "http://fixture/planner", renderer: "renderer-1",
    interaction: "database-planner",
    precondition: { serviceWorker: { ready: true, controlled: true, activeState: "activated", scriptURL: "http://fixture/sw.js" } },
    expected: { state: "resident", semanticMark: "mep:planner:semantic-ready", anchorEntryId: "recipes/a.md::marked", presentationIdentifiers: ["mep:planner-week-range", "mep:planner-card-title:recipes/a.md::marked"], gestureTarget: "button:Planner", activationTarget: "button:Planner" },
    gestures: [
      { type: "pointerdown", timeStamp: 100, isTrusted: true, target: "button:Planner" },
      { type: "pointerup", timeStamp: 180, isTrusted: true, target: "button:Planner" },
      { type: "click", timeStamp: 180, isTrusted: true, target: "button:Planner" },
    ],
    events: [{ name: "pointerdown", startTime: 100, duration: 24, interactionId: 7 }],
    firstInputs: [{ name: "pointerdown", startTime: 100, duration: 24, interactionId: 7 }],
    marks: [{ name: "mep:planner:semantic-ready", startTime: semanticTime, detail: { generation: 1, presetId: "weekly", lanes: [{ id: "marked", cardIds: ["recipes/a.md::marked"] }] } }],
    elements: [
      { identifier: "mep:planner-week-range", presentationTime: presentationTime - 2, frame: "top", renderer: "renderer-1" },
      { identifier: "mep:planner-card-title:recipes/a.md::marked", presentationTime, frame: "top", renderer: "renderer-1" },
    ],
    feedback: { status: "OK", presentationTime: 130 },
    correctness: { passed: true }, consoleErrors: [], pageErrors: [],
  };
}

function underivable(raw, pattern) {
  const result = deriveSample(raw, budget);
  assert.equal(result.status, "UNDERIVABLE");
  assert.match(result.reason, pattern);
}

test("instrumentation state classification is idempotent and fail-closed", () => {
  const edit = { file: "fixture.ts", old: "const oldValue = 1;", replacement: "const replacementValue = 1;" };
  assert.deepEqual(classifyInstrumentationState("before\nconst oldValue = 1;\nafter", edit), { mode: "apply", oldOccurrences: 1, replacementOccurrences: 0 });
  assert.deepEqual(classifyInstrumentationState("before\nconst replacementValue = 1;\nafter", edit), { mode: "preexisting", oldOccurrences: 0, replacementOccurrences: 1 });
  assert.throws(() => classifyInstrumentationState("before\nafter", edit), /old=0, replacement=0/);
  assert.throws(() => classifyInstrumentationState("const oldValue = 1;\nconst replacementValue = 1;", edit), /old=1, replacement=1/);
  assert.throws(() => classifyInstrumentationState("const oldValue = 1;\nconst oldValue = 1;", edit), /old=2, replacement=0/);
});

test("instrumentation classification masks old text nested inside replacement", () => {
  const edit = { file: "fixture.ts", old: "type Persist =", replacement: "let generation = 0;\n\ntype Persist =" };
  assert.equal(classifyInstrumentationState(edit.replacement, edit).mode, "preexisting");
});

test("derives the exact presentation endpoint for either valid post-click order", () => {
  const semanticsFirst = deriveSample(plannerRaw({ semanticTime: 190, presentationTime: 200 }), budget);
  const presentationFirst = deriveSample(plannerRaw({ semanticTime: 210, presentationTime: 200 }), budget);
  for (const result of [semanticsFirst, presentationFirst]) {
    assert.equal(result.status, "OK");
    assert.equal(result.clickToPresentationMs, 20);
    assert.equal(result.pointerdownToPresentationMs, 100);
    assert.equal(result.withinBudget, true);
  }
});

test("uses buffered first-input only when normal pointerdown EventTiming is omitted", () => {
  const fallback = plannerRaw(); fallback.events = [];
  assert.equal(deriveSample(fallback, budget).status, "OK");
  const missing = plannerRaw(); missing.events = []; missing.firstInputs = [];
  underivable(missing, /EventTiming\/first-input count 0/);
  const poisoned = plannerRaw(); poisoned.firstInputs = [{ name: "pointerdown", startTime: 50, duration: 16, interactionId: 1 }];
  underivable(poisoned, /not the page first trusted input/);
});

test("Database to Planner requires both the exact week range and representative semantic card", () => {
  const noWeek = plannerRaw(); noWeek.elements = noWeek.elements.filter((entry) => entry.identifier !== "mep:planner-week-range");
  underivable(noWeek, /mep:planner-week-range presentation count 0/);
  const noCard = plannerRaw(); noCard.elements = noCard.elements.filter((entry) => entry.identifier !== "mep:planner-card-title:recipes\/a.md::marked");
  underivable(noCard, /planner-card-title.*presentation count 0/);
  const wrongSemantic = plannerRaw(); wrongSemantic.marks[0].detail.lanes[0].cardIds = ["recipes/wrong.md::marked"];
  underivable(wrongSemantic, /lacks the exact anchor card/);
});

test("cold and warm navigation derive from navigationStart without inventing a pointer", () => {
  const raw = {
    frame: "top", frameUrl: "http://fixture/", topUrl: "http://fixture/", renderer: "renderer-1",
    interaction: "warm-database", precondition: { serviceWorker: { ready: true, controlled: true, activeState: "activated", scriptURL: "http://fixture/sw.js", warmPrimer: { ready: true, controlled: true, activeState: "activated", scriptURL: "http://fixture/sw.js" } } }, navigation: { startTime: 0, type: "navigate" }, cacheEvidence: { passed: true }, expected: { state: "warm", semanticMark: "mep:database:semantic-ready", recipePath: "recipes/a.md" }, gestures: [],
    marks: [{ name: "mep:database:semantic-ready", startTime: 80, detail: { firstFourPaths: ["recipes/a.md"], firstCoverPath: "recipes/a.md" } }],
    elements: [{ identifier: "recipes/a.md", presentationTime: 90, frame: "top", renderer: "renderer-1" }],
  };
  const result = deriveSample(raw, { navigationStartToSemanticMs: 420, navigationStartToPresentationMs: 120 });
  assert.equal(result.status, "OK");
  assert.equal(result.navigationStartToSemanticMs, 80);
  assert.equal(result.navigationStartToPresentationMs, 90);
});

test("rejects missing, ambiguous, stale, and wrong-target evidence", () => {
  const missingSemantic = plannerRaw(); missingSemantic.marks = []; underivable(missingSemantic, /semantic-ready count 0/);
  const ambiguous = plannerRaw(); ambiguous.elements.push({ ...ambiguous.elements[0], presentationTime: 201 }); underivable(ambiguous, /presentation count 2/);
  const stale = plannerRaw(); stale.marks[0].startTime = 170; underivable(stale, /semantic-ready count 0/);
  const wrongTarget = plannerRaw(); wrongTarget.gestures[2].target = "button:Shopping List"; underivable(wrongTarget, /wrong target/);
});

test("rejects short dwell, untrusted input, cross-frame, and cross-renderer evidence", () => {
  const dwell = plannerRaw(); dwell.gestures[1].timeStamp = 140; dwell.gestures[2].timeStamp = 140; underivable(dwell, /dwell/);
  const longDwell = plannerRaw(); longDwell.gestures[1].timeStamp = 189; longDwell.gestures[2].timeStamp = 189; underivable(longDwell, /exceeds tolerance/);
  const uncontrolled = plannerRaw(); uncontrolled.precondition.serviceWorker.controlled = false; underivable(uncontrolled, /service-worker precondition/);
  const untrusted = plannerRaw(); untrusted.gestures[0].isTrusted = false; underivable(untrusted, /pointerdown count 0/);
  const frame = plannerRaw(); frame.topUrl = "http://other/"; underivable(frame, /cross-frame/);
  const renderer = plannerRaw(); renderer.elements[0].renderer = "renderer-2"; underivable(renderer, /cross-frame or cross-renderer/);
});

test("shopping check-off requires persisted exact-item semantics, not list-load semantics", () => {
  const raw = plannerRaw();
  raw.interaction = "shopping-check";
  raw.expected = { state: "resident", semanticMark: "mep:shopping:check-settled", itemId: "line:2", gestureTarget: "shopping-box:oat milk", activationTarget: "shopping-input:oat milk" };
  raw.gestures[0].target = "shopping-box:oat milk";
  raw.gestures[1].target = "shopping-box:oat milk";
  raw.gestures[2].target = "shopping-box:oat milk";
  raw.gestures.push({ type: "click", timeStamp: 180, isTrusted: true, target: "shopping-input:oat milk" });
  raw.marks = [{ name: "mep:shopping:semantic-ready", startTime: 190, detail: { total: 1 } }];
  raw.elements = [];
  underivable(raw, /check-settled count 0/);
});

test("planner drop requires exact moved-card identity and exact presentation", () => {
  const raw = plannerRaw();
  raw.interaction = "planner-drop";
  raw.expected = { state: "resident", semanticMark: "mep:planner:drop-settled", itemId: "recipes/a.md", targetLaneId: "2026-09-01", targetEntryId: "recipes/a.md::2026-09-01", presentationIdentifier: "mep:planner-card-title:recipes/a.md::2026-09-01", gestureTarget: "planner-card:recipes/a.md::marked", activationTarget: "planner-card:recipes/a.md::marked" };
  raw.gestures = [
    { type: "pointerdown", timeStamp: 100, isTrusted: true, target: raw.expected.gestureTarget },
    { type: "pointerup", timeStamp: 350, isTrusted: true, target: raw.expected.activationTarget },
  ];
  raw.marks[0].startTime = 360;
  raw.marks[0].name = "mep:planner:drop-settled";
  raw.marks[0].detail = { generation: 1, itemId: "recipes/a.md", targetLaneId: "2026-09-01", targetEntryId: raw.expected.targetEntryId, presentationIdentifier: raw.expected.presentationIdentifier };
  raw.elements[0].identifier = raw.expected.presentationIdentifier;
  raw.elements[0].presentationTime = 368;
  const result = deriveSample(raw, { releaseToPresentationMs: 50 });
  assert.equal(result.status, "OK");
  assert.equal(result.releaseToPresentationMs, 18);
  const wrong = structuredClone(raw); wrong.marks[0].detail.targetEntryId = "recipes/wrong.md::2026-09-01";
  assert.match(deriveSample(wrong, { releaseToPresentationMs: 50 }).reason, /exact settled operation/);
});

test("direct sample gates cannot be overridden by correctness or aggregates", () => {
  const over = plannerRaw({ presentationTime: 231 });
  const verdict = evaluateSample(over, budget);
  assert.equal(verdict.passed, false);
  assert.match(verdict.failure, /clickToPresentationMs/);
  const incorrect = plannerRaw(); incorrect.correctness = { passed: false, reason: "wrong landed content" };
  assert.equal(evaluateSample(incorrect, budget).failure, "wrong landed content");
});

test("comparison gate certifies the candidate while requiring a correct derivable control", () => {
  const candidateRaw = plannerRaw();
  const candidateVerdict = evaluateSample(candidateRaw, budget);
  const candidate = { variant: "candidate", raw: candidateRaw, ...candidateVerdict };
  candidate.comparable = isComparableSample(candidate);

  const controlRaw = plannerRaw({ presentationTime: 231 });
  const controlVerdict = evaluateSample(controlRaw, budget);
  const control = { variant: "control", raw: controlRaw, ...controlVerdict };
  control.comparable = isComparableSample(control);
  assert.equal(control.passed, false);
  assert.equal(control.comparable, true);
  assert.deepEqual(evaluateComparison([candidate, control]), { candidatePassed: true, controlComparable: true, passed: true });
  assert.deepEqual(evaluateRun([control], "preflight", "control"), { candidatePassed: false, controlComparable: true, passed: true });
  assert.deepEqual(evaluateRun([candidate], "preflight", "candidate"), { candidatePassed: true, controlComparable: false, passed: true });

  assert.equal(evaluateComparison([{ ...candidate, passed: false }, control]).passed, false);
  const invalidControl = { ...control, comparable: false };
  assert.equal(evaluateComparison([candidate, invalidControl]).passed, false);
  const collectorFailure = { ...control, failure: "page.goto failed" };
  collectorFailure.comparable = isComparableSample(collectorFailure);
  assert.equal(collectorFailure.comparable, false);
  assert.equal(evaluateRun([collectorFailure], "preflight", "control").passed, false);
  assert.equal(evaluateComparison([candidate, collectorFailure]).passed, false);
});

test("CLI enforces a three-pair pilot and gates the ten-pair certification sweep", () => {
  const output = "/tmp/raw.json";
  assert.equal(parseArgs(["--output", output]).pairs, 3);
  assert.throws(() => parseArgs(["--pairs", "10", "--output", output]), /pilot must contain exactly 3/);
  assert.throws(() => parseArgs(["--phase", "certification", "--pairs", "10", "--output", output]), /pilot-artifact/);
  assert.equal(parseArgs(["--phase", "certification", "--pairs", "10", "--pilot-artifact", "/tmp/pilot.json", "--output", output]).pairs, 10);
  assert.equal(parseArgs(["--phase", "preflight", "--pairs", "1", "--only", "database-recipe", "--variant", "candidate", "--output", output]).only, "database-recipe");
  assert.throws(() => parseArgs(["--phase", "preflight", "--pairs", "1", "--output", output]), /preflight requires/);
});


test("certification admission re-derives candidate and control evidence from raw records", () => {
  const expected = { control: "control-ref", candidate: "candidate-ref", anchors: admissionAnchors, instrumentationPlanSha256, comparisonPolicyVersion: COMPARISON_POLICY_VERSION };
  const samples = [];
  for (let pair = 1; pair <= 3; pair += 1) for (const variant of ["control", "candidate"]) for (const interaction of INTERACTIONS) {
    const raw = structuredClone(admissionRaws[interaction]);
    if (variant === "control" && interaction === "database-planner") {
      const click = raw.gestures.find((entry) => entry.type === "click").timeStamp;
      raw.elements.find((entry) => entry.identifier.includes("planner-card-title")).presentationTime = click + 60;
    }
    const verdict = evaluateSample(raw, admissionAnchors[interaction]);
    const sample = { pair, variant, interaction, raw, ...verdict };
    sample.comparable = isComparableSample(sample);
    samples.push(sample);
  }
  const comparison = evaluateComparison(samples);
  const pilot = { phase: "pilot", pairs: 3, ...comparison, samples, contract: { ...expected } };
  assert.equal(samples.filter((sample) => sample.variant === "control" && !sample.passed).length, 3);
  assert.deepEqual(validatePilotAdmission(pilot, expected), []);

  const duplicate = structuredClone(pilot); duplicate.samples[35] = structuredClone(duplicate.samples[0]);
  assert.ok(validatePilotAdmission(duplicate, expected).some((failure) => /duplicate coverage|missing coverage/.test(failure)));
  for (const [field, value, pattern] of [
    ["phase", "certification", /phase/], ["pairs", 10, /pairs/], ["passed", false, /passed/],
    ["candidatePassed", false, /candidate/], ["controlComparable", false, /control/]
  ]) {
    const wrong = structuredClone(pilot); wrong[field] = value;
    assert.ok(validatePilotAdmission(wrong, expected).some((failure) => pattern.test(failure)));
  }

  const staleCandidate = structuredClone(pilot);
  staleCandidate.samples.find((sample) => sample.variant === "candidate").raw.elements = [];
  assert.ok(validatePilotAdmission(staleCandidate, expected).some((failure) => /serialized verdict mismatch|failed candidate/.test(failure)));
  const invalidControl = structuredClone(pilot);
  invalidControl.samples.find((sample) => sample.variant === "control").raw.correctness.passed = false;
  assert.ok(validatePilotAdmission(invalidControl, expected).some((failure) => /serialized verdict mismatch|invalid control/.test(failure)));
  const missingErrors = structuredClone(pilot);
  delete missingErrors.samples.find((sample) => sample.variant === "control").raw.consoleErrors;
  assert.ok(validatePilotAdmission(missingErrors, expected).some((failure) => /serialized verdict mismatch|invalid control/.test(failure)));
  const missingCandidateErrors = structuredClone(pilot);
  delete missingCandidateErrors.samples.find((sample) => sample.variant === "candidate").raw.pageErrors;
  assert.ok(validatePilotAdmission(missingCandidateErrors, expected).some((failure) => /serialized verdict mismatch|failed candidate/.test(failure)));
  const collectorFailure = structuredClone(pilot);
  collectorFailure.samples.find((sample) => sample.variant === "control").failure = "page.goto failed";
  assert.ok(validatePilotAdmission(collectorFailure, expected).some((failure) => /serialized verdict mismatch/.test(failure)));

  for (const [field, value, pattern] of [
    ["instrumentationPlanSha256", "wrong", /digest/], ["comparisonPolicyVersion", "wrong", /policy/]
  ]) {
    const wrong = structuredClone(pilot); wrong.contract[field] = value;
    assert.ok(validatePilotAdmission(wrong, expected).some((failure) => pattern.test(failure)));
  }
});

test("collector provisions a fresh seeded kitchen profile", async () => {
  const source = await readFile(new URL("./benchmark-perceived-latency.mjs", import.meta.url), "utf8");
  assert.match(source, /async function bootSeededKitchen/);
  assert.match(source, /`\$\{baseUrl\}\?latency-cold`/);
  assert.match(source, /`\$\{baseUrl\}\?latency-warm`/);
  assert.match(source, /fresh profile and lets the app seed its kitchen/);
  const standalone = await readFile(new URL("../src/standalone.css", import.meta.url), "utf8");
  const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(standalone, /\.mep-nav__item:active\s*\{[^}]*transform:/s);
  assert.match(standalone, /\.shopping-item__label:active \.shopping-item__box[^}]*transform:/s);
  assert.match(styles, /\.cooking-db__card-open:active\s*\{[^}]*transform:/s);
  assert.match(styles, /\.kanban-item:active,[^}]*transform:/s);
});
