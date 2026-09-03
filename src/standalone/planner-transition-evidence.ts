export const PLANNER_METADATA_PLACEHOLDER_TIMING = "mep:planner-placeholder:metadata";
export type PlannerLaneIdentity = {
  id: string;
  cardIds: string[];
};

export type PlannerBoardIdentity = {
  presetId: string;
  weekStart: string;
  weekEnd: string;
  lanes: PlannerLaneIdentity[];
};

export function plannerBoardIdentityKey(identity: PlannerBoardIdentity): string {
  return JSON.stringify(identity);
}

export function markPlannerSemanticReady(
  generation: number,
  identity: PlannerBoardIdentity
): void {
  if (!Number.isInteger(generation) || generation <= 0) return;
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.mark("mep:planner:semantic-ready", {
    detail: { generation, ...identity }
  });
}
