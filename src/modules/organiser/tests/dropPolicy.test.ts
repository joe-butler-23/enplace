import { describe, expect, it } from "vitest";
import type { ResolveDropContext } from "@/kanban-core";
import {
	MARKED_COLUMN_ID,
	decorateRenderedLanes,
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

describe("decorateRenderedLanes", () => {
	function fakeLane(recipeCardCount: number): HTMLElement {
		const classes = new Set<string>();
		return {
			querySelectorAll: () => new Array(recipeCardCount).fill(null),
			classList: {
				toggle: (name: string, force: boolean) => {
					if (force) classes.add(name);
					else classes.delete(name);
				},
				contains: (name: string) => classes.has(name),
			},
		} as unknown as HTMLElement;
	}

	it("adds the multi-recipe class only when a lane has more than one recipe card", () => {
		const dense = fakeLane(2);
		const sparse = fakeLane(1);
		const elements = new Map([
			["2026-07-14", dense],
			["2026-07-15", sparse],
		]);

		decorateRenderedLanes(elements, ["2026-07-14", "2026-07-15"]);

		expect((dense.classList as unknown as { contains: (name: string) => boolean }).contains("kanban-board--multi-recipe")).toBe(true);
		expect((sparse.classList as unknown as { contains: (name: string) => boolean }).contains("kanban-board--multi-recipe")).toBe(false);
	});

	it("never decorates the marked lane", () => {
		const marked = fakeLane(5);
		decorateRenderedLanes(new Map([[MARKED_COLUMN_ID, marked]]), [MARKED_COLUMN_ID]);
		expect((marked.classList as unknown as { contains: (name: string) => boolean }).contains("kanban-board--multi-recipe")).toBe(false);
	});
});
