import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveTransitionSample,
  evaluateCollectedSample,
  expectedFixture,
  parseArgs,
} from "./benchmark-planner-transition.mjs";

const expected = expectedFixture([
  "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
  "2026-08-14", "2026-08-15", "2026-08-16",
]);

function identity(overrides = {}) {
  return {
    generation: 1,
    presetId: expected.presetId,
    weekStart: expected.weekStart,
    weekEnd: expected.weekEnd,
    lanes: structuredClone(expected.lanes),
    ...overrides,
  };
}

function validRaw() {
  return {
    gestures: [
      { type: "pointerdown", timeStamp: 100, isTrusted: true },
      { type: "click", timeStamp: 180, isTrusted: true },
    ],
    marks: [{ name: "mep:planner:semantic-ready", startTime: 190, detail: identity() }],
    elements: [
      { identifier: "mep:planner-shell", renderTime: 200 },
      { identifier: expected.weekIdentifier, renderTime: 200 },
      { identifier: expected.anchorIdentifier, renderTime: 200 },
    ],
    longTasks: [],
    layoutShifts: [],
  };
}

function underivable(raw, pattern) {
  const result = deriveTransitionSample(raw, expected);
  assert.equal(result.status, "UNDERIVABLE");
  assert.match(result.reason, pattern);
}

test("derives exact click and pointerdown presentation latency", () => {
  const result = deriveTransitionSample(validRaw(), expected);
  assert.equal(result.status, "OK");
  assert.equal(result.clickToPresentationMs, 20);
  assert.equal(result.pointerdownToPresentationMs, 100);
});

test("rejects missing, duplicate, and ambiguous exact presentation entries", () => {
  const missing = validRaw();
  missing.elements = missing.elements.filter((entry) => entry.identifier !== expected.anchorIdentifier);
  underivable(missing, /anchor presentation count 0/);
  const duplicate = validRaw();
  duplicate.elements.push({ identifier: expected.anchorIdentifier, renderTime: 201 });
  underivable(duplicate, /anchor presentation count 2/);
  const duplicateWeek = validRaw();
  duplicateWeek.elements.push({ identifier: expected.weekIdentifier, renderTime: 201 });
  underivable(duplicateWeek, /week presentation count 2/);
});

test("rejects placeholder and empty-shell exact presentations", () => {
  const placeholder = validRaw();
  placeholder.elements.push({ identifier: "mep:planner-placeholder:metadata", renderTime: 185 });
  underivable(placeholder, /placeholder exactly presented/);
  const suspense = validRaw();
  suspense.elements.push({ identifier: "mep:planner-placeholder:suspense", renderTime: 190 });
  underivable(suspense, /placeholder exactly presented/);
  const shell = validRaw();
  shell.elements[0].renderTime = 190;
  underivable(shell, /shell exactly presented before/);
  const toolbar = validRaw();
  toolbar.elements[1].renderTime = 195;
  underivable(toolbar, /toolbar exactly presented before/);
});

test("does not move the endpoint for a placeholder after exact presentation", () => {
  const raw = validRaw();
  raw.elements.push({ identifier: "mep:planner-placeholder:metadata", renderTime: 220 });
  assert.equal(deriveTransitionSample(raw, expected).status, "OK");
});

test("rejects stale, duplicate, invalid-generation, and wrong semantic evidence", () => {
  const stale = validRaw();
  stale.marks[0].startTime = 90;
  underivable(stale, /semantic-ready count 0/);
  const duplicate = validRaw();
  duplicate.marks.push(structuredClone(duplicate.marks[0]));
  underivable(duplicate, /semantic-ready count 2/);
  const invalidGeneration = validRaw();
  invalidGeneration.marks[0].detail.generation = 0;
  underivable(invalidGeneration, /invalid transition generation/);
  const wrong = validRaw();
  wrong.marks[0].detail.weekEnd = "2026-08-17";
  underivable(wrong, /board identity is wrong/);
});

test("rejects wrong, missing, duplicated, and misordered lane/card identities", () => {
  const cases = [];
  const wrong = validRaw();
  wrong.marks[0].detail.lanes[1].cardIds[0] = "recipes/wrong.md::2026-08-10";
  cases.push(wrong);
  const missing = validRaw();
  missing.marks[0].detail.lanes[1].cardIds = [];
  cases.push(missing);
  const duplicated = validRaw();
  duplicated.marks[0].detail.lanes[1].cardIds.push(duplicated.marks[0].detail.lanes[1].cardIds[0]);
  cases.push(duplicated);
  const misordered = validRaw();
  misordered.marks[0].detail.lanes.reverse();
  cases.push(misordered);
  for (const raw of cases) underivable(raw, /board identity is wrong/);
});

test("rejects untrusted/missing gestures, insufficient dwell, pre-click paints, and contamination", () => {
  const untrusted = validRaw();
  untrusted.gestures[0].isTrusted = false;
  underivable(untrusted, /pointerdown count 0/);
  const dwell = validRaw();
  dwell.gestures[1].timeStamp = 140;
  underivable(dwell, /press dwell/);
  const preClick = validRaw();
  preClick.elements[2].renderTime = 170;
  underivable(preClick, /did not occur after/);
  const contaminated = validRaw();
  contaminated.elements.forEach((entry) => { if (entry.identifier !== "mep:planner-shell") entry.renderTime = 1_201; });
  contaminated.elements[0].renderTime = 1_201;
  underivable(contaminated, /sample contamination/);
});


test("keeps single-sample execution private to paired certification", () => {
  assert.throws(() => parseArgs(["--runs", "1", "--output", "/tmp/out.json"]), /paired orchestration/);
  const paired = parseArgs(["--runs", "1", "--paired-sample", "--skip-build", "--output", "/tmp/out.json"]);
  assert.equal(paired.runs, 1);
  assert.equal(parseArgs(["--runs", "3", "--early-click", "--output", "/tmp/out.json"]).earlyClick, true);
  assert.equal(parseArgs(["--runs", "3", "--failure-retry", "--output", "/tmp/out.json"]).failureRetry, true);
});


test("preserves the original collection failure when no raw record exists", () => {
  const verdict = evaluateCollectedSample(
    null,
    { status: "UNDERIVABLE", reason: "sample did not reach derivation" },
    expected,
    "planner exact presentation deadline exceeded",
    false,
  );
  assert.deepEqual(verdict, {
    passed: false,
    failure: "planner exact presentation deadline exceeded",
  });
});


test("fails a derivable sample that exceeds either frozen latency budget", () => {
  const raw = {
    postWindow: { cardsByLane: structuredClone(expected.lanes), loadingTexts: [] },
    consoleErrors: [],
    networkErrors: [],
  };
  const verdict = evaluateCollectedSample(
    raw,
    { status: "OK", clickToPresentationMs: 51, pointerdownToPresentationMs: 131 },
    expected,
    null,
    false,
  );
  assert.equal(verdict.passed, false);
  assert.match(verdict.failure, /latency budget exceeded/);
});
