import { describe, expect, it } from "vitest";
import {
	resolveCardSplitOpen,
	type CardClickIntent,
	type SplitModifierState,
} from "./click-intent";

function makeModifierState(
	overrides: Partial<SplitModifierState> = {}
): SplitModifierState {
	return {
		isPressed: false,
		lastPressedAt: 0,
		...overrides,
	};
}

function makeClickIntent(
	overrides: Partial<Exclude<CardClickIntent, null>> = {}
): Exclude<CardClickIntent, null> {
	return {
		cardId: "a.md",
		split: false,
		at: 1_000,
		...overrides,
	};
}

describe("resolveCardSplitOpen", () => {
	it("opens split when click event carries ctrl/meta", () => {
		const result = resolveCardSplitOpen({
			cardId: "a.md",
			eventSplit: true,
			now: 2_000,
			clickIntent: null,
			modifierState: makeModifierState(),
		});
		expect(result).toBe(true);
	});

	it("opens split when modifier is currently pressed", () => {
		const result = resolveCardSplitOpen({
			cardId: "a.md",
			eventSplit: false,
			now: 2_000,
			clickIntent: null,
			modifierState: makeModifierState({ isPressed: true }),
		});
		expect(result).toBe(true);
	});

	it("opens split for a short grace period after modifier press", () => {
		const result = resolveCardSplitOpen({
			cardId: "a.md",
			eventSplit: false,
			now: 2_100,
			clickIntent: null,
			modifierState: makeModifierState({ lastPressedAt: 2_000 }),
		});
		expect(result).toBe(true);
	});

	it("opens split from fresh click intent on the same item", () => {
		const result = resolveCardSplitOpen({
			cardId: "a.md",
			eventSplit: false,
			now: 2_000,
			clickIntent: makeClickIntent({ split: true, at: 1_300 }),
			modifierState: makeModifierState(),
		});
		expect(result).toBe(true);
	});

	it("does not open split when intent belongs to another item", () => {
		const result = resolveCardSplitOpen({
			cardId: "b.md",
			eventSplit: false,
			now: 2_000,
			clickIntent: makeClickIntent({ cardId: "a.md", split: true, at: 1_700 }),
			modifierState: makeModifierState(),
		});
		expect(result).toBe(false);
	});

	it("does not open split from stale intent", () => {
		const result = resolveCardSplitOpen({
			cardId: "a.md",
			eventSplit: false,
			now: 4_000,
			clickIntent: makeClickIntent({ split: true, at: 1_700 }),
			modifierState: makeModifierState(),
		});
		expect(result).toBe(false);
	});

	it("falls back to normal open when no split signals exist", () => {
		const result = resolveCardSplitOpen({
			cardId: "a.md",
			eventSplit: false,
			now: 2_000,
			clickIntent: makeClickIntent({ split: false, at: 1_900 }),
			modifierState: makeModifierState(),
		});
		expect(result).toBe(false);
	});
});
