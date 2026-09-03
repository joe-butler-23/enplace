// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("App module import (bd mise-en-place-fuy)", () => {
  it("imports under a DOM environment, including the dragula-backed WeeklyOrganiserBoard chain", async () => {
    // App.tsx transitively imports WeeklyOrganiserBoard -> dragula, and dragula reads
    // `document` at module load time (`var doc = document;` at its top level). Under
    // `environment: "node"` that import throws before this test body ever runs. This file
    // opts into `happy-dom` via the docblock above so `document` exists at import time.
    const module = await import("./App");
    expect(typeof module.default).toBe("function");
  });
});
