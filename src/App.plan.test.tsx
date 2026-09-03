// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePlan, parseRecipe } from "./core";

const storage = vi.hoisted(() => ({ plan: "" }));

vi.mock("./host-client/browser-storage", () => ({
  updateText: async (path: string, update: (current: string) => string) => {
    expect(path).toBe("Plan.md");
    storage.plan = update(storage.plan);
    return storage.plan;
  },
  walkFiles: async () => [],
}));

describe("direct Plan.md writes", () => {
  beforeEach(() => { storage.plan = ""; });

  it("applies concurrent recipe planning changes to live text without reading recipe files", async () => {
    const { updatePlanRecipe } = await import("./App");
    const one = parseRecipe("one.md", "# One\n\n## Ingredients\n- one thing\n")!;
    const two = parseRecipe("two.md", "# Two\n\n## Ingredients\n- two things\n")!;

    await Promise.all([
      updatePlanRecipe(one, (planning) => ({ ...planning, marked: true })),
      updatePlanRecipe(two, (planning) => ({ ...planning, marked: true })),
    ]);

    expect(parsePlan(storage.plan).marked).toEqual(["one", "two"]);
  });
});
