import { describe, expect, it, vi } from "vitest";
import { removePlannerRecipe } from "../utils/planner-recipe-removal";

describe("planner recipe removal", () => {
  it("routes a Marked-column X through the authoritative unmark mutation", async () => {
    const removeDateOccurrence = vi.fn();
    const unmarkRecipe = vi.fn().mockResolvedValue(undefined);

    await removePlannerRecipe("marked", removeDateOccurrence, unmarkRecipe);

    expect(unmarkRecipe).toHaveBeenCalledOnce();
    expect(removeDateOccurrence).not.toHaveBeenCalled();
  });

  it("routes a date-column X to only that scheduled occurrence", async () => {
    const removeDateOccurrence = vi.fn().mockResolvedValue(undefined);
    const unmarkRecipe = vi.fn();

    await removePlannerRecipe("2026-07-14", removeDateOccurrence, unmarkRecipe);

    expect(removeDateOccurrence).toHaveBeenCalledWith("2026-07-14");
    expect(unmarkRecipe).not.toHaveBeenCalled();
  });
});
