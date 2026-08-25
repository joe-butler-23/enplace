import { describe, expect, it, vi } from "vitest";
import {
  createPlannerRefreshPriorityState,
  prioritizePlannerRefresh,
  registerPlannerRefreshStart,
  resetPlannerRefreshPriority,
} from "./planner-refresh-priority";

describe("planner refresh priority", () => {
  it("promotes a registered idle start exactly once", () => {
    const state = createPlannerRefreshPriorityState();
    const start = vi.fn();
    const scheduledStart = registerPlannerRefreshStart(state, start);

    expect(start).not.toHaveBeenCalled();
    prioritizePlannerRefresh(state);
    scheduledStart();

    expect(start).toHaveBeenCalledTimes(1);
    expect(state.pendingStart).toBeNull();
  });

  it("starts immediately when intent already has priority", () => {
    const state = createPlannerRefreshPriorityState();
    const start = vi.fn();
    prioritizePlannerRefresh(state);

    registerPlannerRefreshStart(state, start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(state.pendingStart).toBeNull();
  });

  it("resets pending ownership and fences the old scheduled callback", () => {
    const state = createPlannerRefreshPriorityState();
    const start = vi.fn();
    const scheduledStart = registerPlannerRefreshStart(state, start);

    resetPlannerRefreshPriority(state);
    scheduledStart();

    expect(start).not.toHaveBeenCalled();
    expect(state).toEqual({ prioritized: false, pendingStart: null, generation: 1 });
  });
});
