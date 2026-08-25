import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markPlannerSemanticReady,
  plannerBoardIdentityKey,
  type PlannerBoardIdentity
} from "./planner-transition-evidence";

const identity: PlannerBoardIdentity = {
  presetId: "weekly",
  weekStart: "2026-08-10",
  weekEnd: "2026-08-16",
  lanes: [
    { id: "marked", cardIds: [] },
    { id: "2026-08-10", cardIds: ["recipes/anchor.md::2026-08-10"] }
  ]
};

afterEach(() => vi.restoreAllMocks());

describe("planner transition evidence", () => {
  it("derives card identifiers and ordered board keys from real identities", () => {
    expect(plannerBoardIdentityKey(identity)).not.toBe(
      plannerBoardIdentityKey({ ...identity, lanes: [...identity.lanes].reverse() })
    );
  });

  it("marks only positive transition generations with the full ordered identity", () => {
    const mark = vi.spyOn(performance, "mark").mockImplementation(() => ({} as PerformanceMark));
    markPlannerSemanticReady(0, identity);
    expect(mark).not.toHaveBeenCalled();
    markPlannerSemanticReady(3, identity);
    expect(mark).toHaveBeenCalledWith("mep:planner:semantic-ready", {
      detail: { generation: 3, ...identity }
    });
  });
});
