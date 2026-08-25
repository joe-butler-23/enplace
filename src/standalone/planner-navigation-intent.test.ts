import { describe, expect, it } from "vitest";
import {
  acknowledgePlannerBoardReady,
  cancelPlannerNavigation,
  createPlannerNavigationIntentState,
  failPlannerNavigation,
  requestPlannerNavigation,
  retryPlannerNavigation,
  settlePlannerNavigation,
} from "./planner-navigation-intent";

describe("planner navigation intent", () => {
  it("settles only after authoritative dataset readiness", () => {
    const state = createPlannerNavigationIntentState();
    const requested = requestPlannerNavigation(state, "push");
    expect(settlePlannerNavigation(state, false)).toBeNull();
    expect(settlePlannerNavigation(state, true)).toBeNull();
    acknowledgePlannerBoardReady(state);
    expect(settlePlannerNavigation(state, true)).toEqual(requested);
    expect(settlePlannerNavigation(state, true)).toBeNull();
  });

  it("supersedes and cancels stale pending intents", () => {
    const state = createPlannerNavigationIntentState();
    requestPlannerNavigation(state, "push");
    const latest = requestPlannerNavigation(state, "replace");
    acknowledgePlannerBoardReady(state);
    expect(settlePlannerNavigation(state, true)).toEqual(latest);
    requestPlannerNavigation(state, "none");
    cancelPlannerNavigation(state);
    expect(settlePlannerNavigation(state, true)).toBeNull();
  });
  it("retains a failed intent for a distinct retry", () => {
    const state = createPlannerNavigationIntentState();
    requestPlannerNavigation(state, "push");
    acknowledgePlannerBoardReady(state);
    failPlannerNavigation(state, "EACCES");
    expect(settlePlannerNavigation(state, true)).toBeNull();
    expect(state.pending).not.toBeNull();
    retryPlannerNavigation(state);
    acknowledgePlannerBoardReady(state);
    expect(settlePlannerNavigation(state, true)?.history).toBe("push");
  });

});
