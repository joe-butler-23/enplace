// Consumers encode column/type policies as a `resolveDrop` function instead of
// the core hardcoding any lane vocabulary. See
// src/modules/organiser/kanban/dropPolicy.ts for MEP's concrete policy.

export type ResolveDropContext = {
	cardId: string;
	sourceLaneId?: string;
	targetLaneId: string;
	isTemplate: boolean;
	duplicateModifier: boolean;
};

export type DropOutcome = "move" | "copy" | "remove" | "reject";

export type ResolveDrop = (ctx: ResolveDropContext) => DropOutcome;

// Default outcome used when no app-supplied `resolveDrop` hook is
// configured: no lane-specific policy at all (that belongs entirely to a
// caller's own resolveDrop), just the bare duplicate-modifier signal a
// generic consumer without templates or marked-style lanes would expect.
export function resolveDropOutcome(ctx: ResolveDropContext, resolveDrop?: ResolveDrop): DropOutcome {
	if (resolveDrop) return resolveDrop(ctx);
	if (ctx.duplicateModifier && !ctx.isTemplate) return "copy";
	return "move";
}
