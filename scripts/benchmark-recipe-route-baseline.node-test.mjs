import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBaseline } from "./benchmark-recipe-route-baseline.mjs";

function validSummary() {
  const detail = {
    imageRect: { left: 100, width: 700, height: 500 },
    viewport: { height: 1000 },
    contentColumnLeft: 100,
    bannerTexts: [],
    cardCoverGeometry: { width: 220, height: 220 }
  };
  return {
    completedRuns: 5,
    fallbackFrames: { database: { max: 0 }, health: { max: 0 } },
    routePaintMs: {
      database: { p95: 10 },
      health: { p95: 10 },
      detail: { p95: 10 },
      reopenDetail: { p95: 10 }
    },
    detailStability: { blankFrames: { max: 0 }, sourceSwapFrames: { max: 0 } },
    geometry: Array.from({ length: 5 }, () => ({
      portraitCount: 1,
      landscapeCount: 1,
      coverAspectRange: { min: 1, max: 1.001 },
      coverHeightRange: { min: 200, max: 200.5 }
    })),
    samples: Array.from({ length: 5 }, () => [
      { label: "first-visible" },
      { label: "portrait-source" },
      { label: "middle-dataset" }
    ]),
    detailEvidence: [{ detail, reopen: detail }]
  };
}

test("route baseline accepts the fixed contract", () => {
  assert.deepEqual(evaluateBaseline(validSummary()), []);
});

test("route baseline rejects a missing summary and incomplete five-run evidence", () => {
  assert.deepEqual(evaluateBaseline(null), ["benchmark summary is missing"]);
  const summary = validSummary();
  summary.samples = [];
  summary.geometry = [];
  const failures = evaluateBaseline(summary);
  assert.ok(failures.some((failure) => failure.includes("detail samples must contain exactly 5 runs")));
  assert.ok(failures.some((failure) => failure.includes("cover geometry must contain exactly 5 runs")));
});

test("route baseline reports fallback, paint, stability, geometry, and detail violations", () => {
  const summary = validSummary();
  summary.fallbackFrames.database.max = 1;
  summary.routePaintMs.detail.p95 = 131;
  summary.detailStability.blankFrames.max = 1;
  summary.geometry[0].coverHeightRange.max = 202;
  summary.detailEvidence[0].detail.imageRect.width = 721;
  summary.detailEvidence[0].detail.bannerTexts = ["Banner"];
  const failures = evaluateBaseline(summary);
  assert.ok(failures.some((failure) => failure.includes("fallback")));
  assert.ok(failures.some((failure) => failure.includes("paint p95")));
  assert.ok(failures.some((failure) => failure.includes("blank frames")));
  assert.ok(failures.some((failure) => failure.includes("cover height")));
  assert.ok(failures.some((failure) => failure.includes("image width")));
  assert.ok(failures.some((failure) => failure.includes("banner")));
});
