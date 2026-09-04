import { describe, expect, it } from "vitest";
import {
  acknowledgePlannerMountReady,
  cancelPlannerNavigation,
  createPlannerNavigationIntentState,
  requestPlannerNavigation,
  retryPlannerNavigation,
  settlePlannerNavigation,
} from "./planner-navigation-intent";

describe("planner navigation intent", () => {
  it("settles only after authoritative mount readiness", () => {
    const state = createPlannerNavigationIntentState();
    const requested = requestPlannerNavigation(state, "push");
    expect(settlePlannerNavigation(state, false)).toBeNull();
    expect(settlePlannerNavigation(state, true)).toBeNull();
    acknowledgePlannerMountReady(state);
    expect(settlePlannerNavigation(state, true)).toEqual(requested);
    expect(settlePlannerNavigation(state, true)).toBeNull();
  });

  it("supersedes and cancels stale pending intents", () => {
    const state = createPlannerNavigationIntentState();
    requestPlannerNavigation(state, "push");
    const latest = requestPlannerNavigation(state, "replace");
    acknowledgePlannerMountReady(state);
    expect(settlePlannerNavigation(state, true)).toEqual(latest);
    requestPlannerNavigation(state, "none");
    cancelPlannerNavigation(state);
    expect(settlePlannerNavigation(state, true)).toBeNull();
  });
  it("requires fresh mount readiness after a retry", () => {
    const state = createPlannerNavigationIntentState();
    requestPlannerNavigation(state, "push");
    acknowledgePlannerMountReady(state);
    retryPlannerNavigation(state);
    expect(settlePlannerNavigation(state, true)).toBeNull();
    acknowledgePlannerMountReady(state);
    expect(settlePlannerNavigation(state, true)?.history).toBe("push");
  });

});
