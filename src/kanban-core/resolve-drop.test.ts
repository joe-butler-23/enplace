import { describe, expect, it } from "vitest";
import { resolveDropOutcome, type ResolveDropContext } from "./resolve-drop";

function buildContext(overrides: Partial<ResolveDropContext> = {}): ResolveDropContext {
	return {
		cardId: "card-1",
		sourceLaneId: "lane-a",
		targetLaneId: "lane-b",
		isTemplate: false,
		duplicateModifier: false,
		...overrides,
	};
}

describe("resolveDropOutcome", () => {
	it("defaults to move with no hook and no duplicate modifier", () => {
		expect(resolveDropOutcome(buildContext())).toBe("move");
	});

	it("defaults to copy when the duplicate modifier is held and the card is not a template", () => {
		expect(resolveDropOutcome(buildContext({ duplicateModifier: true }))).toBe("copy");
	});

	it("ignores the duplicate modifier for templates in the default policy", () => {
		expect(resolveDropOutcome(buildContext({ duplicateModifier: true, isTemplate: true }))).toBe("move");
	});

	it("delegates entirely to a supplied resolveDrop hook", () => {
		const ctx = buildContext({ targetLaneId: "marked" });
		const resolveDrop = () => "reject" as const;
		expect(resolveDropOutcome(ctx, resolveDrop)).toBe("reject");
	});

	it("passes the exact context through to the hook", () => {
		const ctx = buildContext({ targetLaneId: "marked" });
		let received: ResolveDropContext | null = null;
		resolveDropOutcome(ctx, (received_ctx) => {
			received = received_ctx;
			return "remove";
		});
		expect(received).toEqual(ctx);
	});
});
