import { describe, expect, it, vi } from "vitest";
import { createDragIntentTracker } from "./drag-intent";

describe("createDragIntentTracker", () => {
	it("has no active intent before any drag starts", () => {
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed: () => false });
		expect(tracker.active()).toBeNull();
	});

	it("resolves duplicate false when not a template and the modifier is not pressed", () => {
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed: () => false });

		const intent = tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });

		expect(intent).toEqual({ cardId: "a.md", sourceLaneId: "todo", duplicate: false, isTemplate: false });
		expect(tracker.active()).toBe(intent);
	});

	it("resolves duplicate true when the duplicate modifier is pressed", () => {
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed: () => true });

		const intent = tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });

		expect(intent.duplicate).toBe(true);
	});

	it("forces duplicate true for a template card even when the modifier is not pressed", () => {
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed: () => false });

		const intent = tracker.resolveAtStart({ cardId: "template.md", sourceLaneId: "ideas", isTemplate: true });

		expect(intent.duplicate).toBe(true);
		expect(intent.isTemplate).toBe(true);
	});

	it("memoizes the same intent object while the same card stays active", () => {
		const isDuplicateModifierPressed = vi.fn().mockReturnValue(false);
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed });

		const first = tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });
		isDuplicateModifierPressed.mockReturnValue(true);
		const second = tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });

		expect(second).toBe(first);
		expect(second.duplicate).toBe(false);
		expect(isDuplicateModifierPressed).toHaveBeenCalledTimes(1);
	});

	it("resolves a fresh intent when a different card starts dragging", () => {
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed: () => false });

		const first = tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });
		const second = tracker.resolveAtStart({ cardId: "b.md", sourceLaneId: "doing", isTemplate: false });

		expect(second).not.toBe(first);
		expect(second.cardId).toBe("b.md");
		expect(tracker.active()).toBe(second);
	});

	it("clear drops the active intent so the next resolve recomputes from current inputs", () => {
		const isDuplicateModifierPressed = vi.fn().mockReturnValue(false);
		const tracker = createDragIntentTracker({ isDuplicateModifierPressed });

		tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });
		tracker.clear();
		expect(tracker.active()).toBeNull();

		isDuplicateModifierPressed.mockReturnValue(true);
		const resolved = tracker.resolveAtStart({ cardId: "a.md", sourceLaneId: "todo", isTemplate: false });

		expect(resolved.duplicate).toBe(true);
		expect(isDuplicateModifierPressed).toHaveBeenCalledTimes(2);
	});
});
