import { describe, expect, it } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ResolveDropContext } from "../kanban/dropPolicy";
import { entryOrdersAfterDrop, insertionIndexForDrop } from "../components/WeeklyPlannerDnd";
import {
	MARKED_COLUMN_ID,
	laneClassNameFor,
	resolveOrganiserDrop,
} from "../kanban/dropPolicy";

function buildContext(overrides: Partial<ResolveDropContext> = {}): ResolveDropContext {
	return {
		cardId: "recipes/soup.md",
		sourceLaneId: "2026-07-14",
		targetLaneId: "2026-07-15",
		isTemplate: false,
		duplicateModifier: false,
		...overrides,
	};
}

describe("resolveOrganiserDrop", () => {
	it("blocks duplicate to marked: a duplicate-modifier drop onto marked is a plain move, not a copy", () => {
		const outcome = resolveOrganiserDrop(
		buildContext({ targetLaneId: MARKED_COLUMN_ID, duplicateModifier: true })
		);
		expect(outcome).toBe("move");
	});

	it("moves recipes dropped on marked", () => {
		const outcome = resolveOrganiserDrop(
			buildContext({ targetLaneId: MARKED_COLUMN_ID })
		);
		expect(outcome).toBe("move");
	});

	it("copies a real card to a normal lane when the duplicate modifier is held", () => {
		const outcome = resolveOrganiserDrop(buildContext({ duplicateModifier: true }));
		expect(outcome).toBe("copy");
	});

	it("moves a real card with no modifier and no marked involvement", () => {
		const outcome = resolveOrganiserDrop(buildContext());
		expect(outcome).toBe("move");
	});
});

describe("laneClassNameFor", () => {
	it("classes only the marked lane", () => {
		expect(laneClassNameFor(MARKED_COLUMN_ID)).toBe("kanban-board--marked");
		expect(laneClassNameFor("2026-07-15")).toBe("");
	});
});


type Entry = Parameters<typeof entryOrdersAfterDrop>[4] extends Map<string, (infer T)[]> ? T : never;
const event = (overId: string | null, translatedTop: number | null = null) => ({
	active: { rect: { current: { translated: translatedTop === null ? null : { top: translatedTop } } } },
	over: overId === null ? null : { id: overId, rect: { top: 0, height: 10 } },
} as DragEndEvent);
const entries = (columnId: string, ids: string[]) => ids.map((entryId) => ({ entryId, filePath: entryId.split("::")[0], columnId } as Entry));
const drag = { entryId: "a::source", filePath: "a", sourceColumnId: "source", duplicate: false };

describe("planner pointer ordering", () => {
	it.each([
		[null, null, 2], ["missing", null, 2], ["one", null, 0], ["one", 6, 1], ["two", 6, 2],
	] as const)("places over %s at the intended bounded index", (overId, top, expected) => {
		expect(insertionIndexForDrop(event(overId, top), ["one", "two"])).toBe(expected);
	});

	it("reorders a lane and rejects missing, stationary, or duplicate entries", () => {
		const same = new Map([["source", entries("source", ["a::source", "b::source", "c::source"])]]);
		expect(entryOrdersAfterDrop(event("b::source", 6), drag, "source", false, same)?.sourceIds).toEqual(["b::source", "a::source", "c::source"]);
		expect(entryOrdersAfterDrop(event("a::source"), drag, "source", false, same)).toBeNull();
		expect(entryOrdersAfterDrop(event("a::source"), { ...drag, entryId: "missing" }, "source", false, same)).toBeNull();
		const duplicate = new Map([["source", entries("source", ["a::source"])], ["target", entries("target", ["a::target"])]]);
		expect(entryOrdersAfterDrop(event("a::target"), drag, "target", true, duplicate)).toBeNull();
	});

	it.each([[false, []], [true, ["a::source"]]] as const)("%s duplication updates both lane orders", (duplicate, expectedSource) => {
		const lanes = new Map([["source", entries("source", ["a::source"])], ["target", entries("target", ["b::target", "c::target"])]]);
		expect(entryOrdersAfterDrop(event("c::target", 6), drag, "target", duplicate, lanes)).toEqual({ sourceIds: expectedSource, targetIds: ["b::target", "c::target", "a::target"], targetEntryId: "a::target" });
	});
});
