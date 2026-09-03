// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

describe("App module import (bd mise-en-place-fuy)", () => {
  it("imports under a DOM environment, including the WeeklyOrganiserBoard chain", async () => {
    const module = await import("./App");
    expect(typeof module.default).toBe("function");
  });
});
