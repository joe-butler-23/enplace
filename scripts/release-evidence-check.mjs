import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBudget } from "./check-release-budgets.mjs";
import { assetReferences } from "./report-web-bundle.mjs";

test("bundle references are attributed without external visualizer metadata", () => {
  assert.deepEqual(assetReferences('import "./vendor.js"; import("./lazy.js");'), ["lazy.js", "vendor.js"]);
});

test("release budgets reject route and invariant regressions", () => {
  const budgets = {
    initialRouteGzipBytes: 100,
    benchmark: {
      p95FrameGapMs: 18,
      warmReadinessP95Ms: 5120,
      maxEmptyCovers: 0,
      maxBlankCovers: 0,
      maxErrorCovers: 0,
      maxIncompleteImages: 0,
      maxSyntheticImages: 0,
      scrollImageResponses: 0,
      scrollImageBytes: 0
    }
  };
  const failures = evaluateBudget(
    { initialRouteGzipBytes: 101, chunks: [] },
    {
      p95FrameGap: { p95: 25 },
      readinessMs: { warm: { p95: 5121 } },
      maxEmptyCovers: 1,
      maxBlankCovers: 0,
      maxErrorCovers: 0,
      maxIncompleteImages: 0,
      maxSyntheticImages: 0,
      imageTransport: {
        coldScrollResponses: { max: 0 },
        warmScrollResponses: { max: 0 },
        coldScrollBytes: { max: 0 },
        warmScrollBytes: { max: 0 }
      }
    },
    budgets
  );
  assert.equal(failures.length, 4);
  assert.match(failures[0], /initial route gzip/);
});

test("release budgets reject cold-readiness, warm-readiness-median, and severe-frame regressions", () => {
  const budgets = {
    initialRouteGzipBytes: 450000,
    benchmark: {
      p95FrameGapMs: 18,
      coldReadinessP95Ms: 4000,
      warmReadinessP95Ms: 5120,
      warmReadinessMedianMs: 3000,
      severeFrames: 0,
      maxEmptyCovers: 0,
      maxBlankCovers: 0,
      maxErrorCovers: 0,
      maxIncompleteImages: 0,
      maxSyntheticImages: 0,
      scrollImageResponses: 0,
      scrollImageBytes: 0
    }
  };
  const failures = evaluateBudget(
    { initialRouteGzipBytes: 1000, chunks: [] },
    {
      p95FrameGap: { p95: 10 },
      readinessMs: { cold: { p95: 4001 }, warm: { p95: 100, median: 3001 } },
      totalSevereFrames: 1,
      maxEmptyCovers: 0,
      maxBlankCovers: 0,
      maxErrorCovers: 0,
      maxIncompleteImages: 0,
      maxSyntheticImages: 0,
      imageTransport: {
        coldScrollResponses: { max: 0 },
        warmScrollResponses: { max: 0 },
        coldScrollBytes: { max: 0 },
        warmScrollBytes: { max: 0 }
      }
    },
    budgets
  );
  assert.equal(failures.length, 3);
  assert.match(failures[0], /cold readiness p95/);
  assert.match(failures[1], /warm readiness median/);
  assert.match(failures[2], /severe frames/);
});
