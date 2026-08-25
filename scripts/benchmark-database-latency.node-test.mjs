#!/usr/bin/env node
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expectedRecipeOrder, percentile } from "./benchmark-database-latency.mjs";

describe("cold database benchmark contract helpers", () => {
  it("uses nearest-rank percentiles without interpolation", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
    assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
    assert.equal(percentile([], 95), null);
  });

  it("derives all 500 deterministic paths in canonical added-desc order", () => {
    const paths = expectedRecipeOrder();
    assert.equal(paths.length, 500);
    assert.equal(new Set(paths).size, 500);
    assert.deepEqual(paths.slice(0, 4), [
      "recipes/visual-fixture-028.md",
      "recipes/visual-fixture-056.md",
      "recipes/visual-fixture-084.md",
      "recipes/visual-fixture-112.md",
    ]);
    assert.equal(paths.at(-1), "recipes/visual-fixture-477.md");
  });
});
