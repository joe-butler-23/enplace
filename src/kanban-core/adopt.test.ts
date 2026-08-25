import { describe, expect, it, vi } from "vitest";
import { createAdoptKanbanCore } from "./adopt";

class FakeElement {
	readonly attrs = new Map<string, string>();
	children: FakeElement[] = [];
	parentNode: FakeElement | null = null;

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	appendChild(child: FakeElement): FakeElement {
		child.parentNode?.detach(child);
		this.children.push(child);
		child.parentNode = this;
		return child;
	}

	insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
		child.parentNode?.detach(child);
		const index = reference ? this.children.indexOf(reference) : -1;
		this.children.splice(index === -1 ? this.children.length : index, 0, child);
		child.parentNode = this;
		return child;
	}

	detach(child: FakeElement): void {
		const index = this.children.indexOf(child);
		if (index !== -1) this.children.splice(index, 1);
	}

	querySelectorAll(selector: string): FakeElement[] {
		const attribute = selector.match(/^\[([\w-]+)\]$/)?.[1];
		if (!attribute) return [];
		const matches: FakeElement[] = [];
		const visit = (element: FakeElement) => {
			for (const child of element.children) {
				if (child.attrs.has(attribute)) matches.push(child);
				visit(child);
			}
		};
		visit(this);
		return matches;
	}

	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

function asHTMLElement(element: FakeElement): HTMLElement {
	return element as unknown as HTMLElement;
}

function board(lanes: Array<{ id: string; cards: string[] }>): FakeElement {
	const root = new FakeElement();
	for (const lane of lanes) {
		const laneElement = new FakeElement();
		laneElement.setAttribute("data-kanban-lane", lane.id);
		const cards = new FakeElement();
		cards.setAttribute("data-kanban-cards", "");
		for (const cardId of lane.cards) {
			const card = new FakeElement();
			card.setAttribute("data-kanban-card", cardId);
			cards.appendChild(card);
		}
		laneElement.appendChild(cards);
		root.appendChild(laneElement);
	}
	return root;
}

function cards(root: FakeElement, laneId: string): FakeElement {
	const lane = root.querySelectorAll("[data-kanban-lane]").find((element) => element.getAttribute("data-kanban-lane") === laneId);
	if (!lane) throw new Error(`Lane not found: ${laneId}`);
	const result = lane.querySelector("[data-kanban-cards]");
	if (!result) throw new Error(`Cards not found: ${laneId}`);
	return result;
}

function order(root: FakeElement, laneId: string): string[] {
	return cards(root, laneId).children.map((card) => card.getAttribute("data-kanban-card")!);
}

function card(root: FakeElement, cardId: string): FakeElement {
	const result = root.querySelectorAll("[data-kanban-card]").find((element) => element.getAttribute("data-kanban-card") === cardId);
	if (!result) throw new Error(`Card not found: ${cardId}`);
	return result;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	return {
		promise: new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		}),
		resolve,
		reject,
	};
}

describe("createAdoptKanbanCore", () => {
	it.each([
		{ cardId: "a", targetLaneId: "right", index: 0, left: ["b", "c"], right: ["a", "d", "e"] },
		{ cardId: "b", targetLaneId: "right", index: 1, left: ["a", "c"], right: ["d", "b", "e"] },
		{ cardId: "c", targetLaneId: "right", index: 2, left: ["a", "b"], right: ["d", "e", "c"] },
		{ cardId: "b", targetLaneId: "left", index: 0, left: ["b", "a", "c"], right: ["d", "e"] },
	])("moves $cardId to the exact post-exclusion index", async ({ cardId, targetLaneId, index, left, right }) => {
		const root = board([{ id: "left", cards: ["a", "b", "c"] }, { id: "right", cards: ["d", "e"] }]);
		const onMove = vi.fn().mockResolvedValue(undefined);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));

		await expect(core.handleDrop({ cardId, targetLaneId, index })).resolves.toBe("confirmed");
		expect(order(root, "left")).toEqual(left);
		expect(order(root, "right")).toEqual(right);
		expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ cardId, targetLaneId, index }));
	});

	it("restores a pointer-pre-moved card before the shared drop path", async () => {
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const core = createAdoptKanbanCore({ source: { onMove: vi.fn().mockResolvedValue(undefined) } });
		core.adopt(asHTMLElement(root));
		core.beginDrag("a");
		cards(root, "right").appendChild(card(root, "a"));

		await core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);
	});

	it("restores a pointer-pre-move before rejecting an invalid index", async () => {
		const root = board([{ id: "left", cards: ["a"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn();
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));
		core.beginDrag("a");
		cards(root, "right").appendChild(card(root, "a"));

		await expect(core.handleDrop({ cardId: "a", targetLaneId: "right", index: 2 })).rejects.toThrow("Invalid kanban drop index: 2");
		expect(order(root, "left")).toEqual(["a"]);
		expect(order(root, "right")).toEqual(["d"]);
		expect(onMove).not.toHaveBeenCalled();
	});

	it("coalesces identical pending drops and serializes distinct drops", async () => {
		const first = deferred<void>();
		const second = deferred<void>();
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));

		const firstDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		expect(core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 })).toBe(firstDrop);
		const secondDrop = core.handleDrop({ cardId: "b", targetLaneId: "right", index: 1 });
		expect(onMove).toHaveBeenCalledTimes(1);
		first.resolve(undefined);
		await expect(firstDrop).resolves.toBe("confirmed");
		expect(onMove).toHaveBeenCalledTimes(2);
		second.resolve(undefined);
		await expect(secondDrop).resolves.toBe("confirmed");
	});

	it("restores a second pointer-pre-move before coalescing an identical pending drop", async () => {
		const pending = deferred<void>();
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn().mockImplementationOnce(() => pending.promise);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));

		core.beginDrag("a");
		cards(root, "right").appendChild(card(root, "a"));
		const firstDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });

		core.beginDrag("a");
		cards(root, "right").appendChild(card(root, "a"));
		const duplicateDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });

		expect(duplicateDrop).toBe(firstDrop);
		expect(onMove).toHaveBeenCalledOnce();
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);
		pending.resolve(undefined);
		await expect(firstDrop).resolves.toBe("confirmed");
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);
	});

	it("restores a nonmatching pointer-pre-move before coalescing another card's pending drop", async () => {
		const pending = deferred<void>();
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn().mockImplementationOnce(() => pending.promise);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));

		const firstDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		core.beginDrag("b");
		cards(root, "right").appendChild(card(root, "b"));
		const duplicateDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });

		expect(duplicateDrop).toBe(firstDrop);
		expect(onMove).toHaveBeenCalledOnce();
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);
		core.cancelDrag();
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);

		pending.resolve(undefined);
		await expect(firstDrop).resolves.toBe("confirmed");
	});

	it("restores a pointer-pre-move before an indeterminate blocked-generation return", async () => {
		const pending = deferred<"indeterminate">();
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn().mockImplementationOnce(() => pending.promise);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));

		const indeterminate = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		pending.resolve("indeterminate");
		await expect(indeterminate).resolves.toBe("indeterminate");

		core.beginDrag("b");
		cards(root, "right").appendChild(card(root, "b"));
		await expect(core.handleDrop({ cardId: "b", targetLaneId: "right", index: 1 })).resolves.toBe("indeterminate");

		expect(onMove).toHaveBeenCalledOnce();
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);
	});

	it("restores a queued pointer-pre-move before applying its final authoritative order", async () => {
		const first = deferred<void>();
		const second = deferred<void>();
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));

		const firstDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		core.beginDrag("b");
		cards(root, "right").appendChild(card(root, "b"));
		const secondDrop = core.handleDrop({ cardId: "b", targetLaneId: "right", index: 1 });

		expect(onMove).toHaveBeenCalledOnce();
		expect(order(root, "left")).toEqual(["b"]);
		expect(order(root, "right")).toEqual(["a", "d"]);
		first.resolve(undefined);
		await expect(firstDrop).resolves.toBe("confirmed");
		expect(onMove).toHaveBeenCalledTimes(2);
		second.resolve(undefined);
		await expect(secondDrop).resolves.toBe("confirmed");
		expect(order(root, "left")).toEqual([]);
		expect(order(root, "right")).toEqual(["a", "b", "d"]);
	});

	it("reports rejection after exact rollback even when error reporting throws", async () => {
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onSettled = vi.fn();
		const core = createAdoptKanbanCore({
			source: { onMove: vi.fn().mockRejectedValue(new Error("rejected")), onMoveError: () => { throw new Error("report failed"); } },
			onSettled,
		});
		core.adopt(asHTMLElement(root));

		await expect(core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 })).resolves.toBe("rejected");
		expect(order(root, "left")).toEqual(["a", "b"]);
		expect(order(root, "right")).toEqual(["d"]);
		expect(onSettled).toHaveBeenCalledWith("rejected", expect.objectContaining({ cardId: "a" }));
	});

	it("keeps fresh server-only cards anchored while restoring cached order in its occupied slots", async () => {
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: [] }]);
		const core = createAdoptKanbanCore({ source: { onMove: vi.fn().mockResolvedValue(undefined) } });
		core.adopt(asHTMLElement(root));

		await expect(core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 })).resolves.toBe("confirmed");

		const freshRoot = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["a"] }]);
		core.adopt(asHTMLElement(freshRoot));

		expect(order(freshRoot, "left")).toEqual(["a", "b"]);
		expect(order(freshRoot, "right")).toEqual(["a"]);
	});

	it("projects confirmed cached order into the original fresh SSR slots across lanes", async () => {
		const root = board([
			{ id: "left", cards: ["d", "e", "f"] },
			{ id: "right", cards: ["g", "h", "i"] },
		]);
		const core = createAdoptKanbanCore({ source: { onMove: vi.fn().mockResolvedValue(undefined) } });
		core.adopt(asHTMLElement(root));

		await expect(core.handleDrop({ cardId: "e", targetLaneId: "left", index: 0 })).resolves.toBe("confirmed");
		await expect(core.handleDrop({ cardId: "f", targetLaneId: "left", index: 1 })).resolves.toBe("confirmed");
		await expect(core.handleDrop({ cardId: "i", targetLaneId: "right", index: 0 })).resolves.toBe("confirmed");
		await expect(core.handleDrop({ cardId: "h", targetLaneId: "right", index: 1 })).resolves.toBe("confirmed");

		const freshRoot = board([
			{ id: "left", cards: ["u", "d", "v", "e", "w", "f"] },
			{ id: "right", cards: ["x", "g", "y", "h", "z", "i"] },
		]);
		core.adopt(asHTMLElement(freshRoot));

		expect(order(freshRoot, "left")).toEqual(["u", "e", "v", "f", "w", "d"]);
		expect(order(freshRoot, "right")).toEqual(["x", "i", "y", "h", "z", "g"]);
	});

	it("keeps one queue across roots and makes stale completion indeterminate without onSettled", async () => {
		const oldMove = deferred<void>();
		const newMove = deferred<void>();
		const oldRoot = board([{ id: "left", cards: ["a"] }, { id: "right", cards: [] }]);
		const newRoot = board([{ id: "left", cards: ["b"] }, { id: "right", cards: [] }]);
		const onMove = vi.fn().mockImplementationOnce(() => oldMove.promise).mockImplementationOnce(() => newMove.promise);
		const onSettled = vi.fn();
		const core = createAdoptKanbanCore({ source: { onMove }, onSettled });
		core.adopt(asHTMLElement(oldRoot));
		const oldDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		core.adopt(asHTMLElement(newRoot));
		const newDrop = core.handleDrop({ cardId: "b", targetLaneId: "right", index: 0 });

		expect(onMove).toHaveBeenCalledTimes(1);
		oldMove.resolve(undefined);
		await expect(oldDrop).resolves.toBe("indeterminate");
		expect(onSettled).not.toHaveBeenCalled();
		expect(onMove).toHaveBeenCalledTimes(2);
		newMove.resolve(undefined);
		await expect(newDrop).resolves.toBe("confirmed");
		expect(order(newRoot, "left")).toEqual([]);
		expect(order(newRoot, "right")).toEqual(["b"]);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("does not report a stale rejection through onMoveError after adoption", async () => {
		const oldMove = deferred<void>();
		const oldRoot = board([{ id: "left", cards: ["a"] }, { id: "right", cards: [] }]);
		const newRoot = board([{ id: "left", cards: ["b"] }, { id: "right", cards: [] }]);
		const onMoveError = vi.fn(() => {
			cards(newRoot, "right").appendChild(card(newRoot, "b"));
		});
		const core = createAdoptKanbanCore({
			source: { onMove: vi.fn().mockImplementationOnce(() => oldMove.promise), onMoveError },
		});
		core.adopt(asHTMLElement(oldRoot));
		const oldDrop = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		core.adopt(asHTMLElement(newRoot));

		oldMove.reject(new Error("rejected"));
		await expect(oldDrop).resolves.toBe("indeterminate");
		expect(onMoveError).not.toHaveBeenCalled();
		expect(order(newRoot, "left")).toEqual(["b"]);
		expect(order(newRoot, "right")).toEqual([]);
	});

	it("blocks further drops after indeterminate until fresh adoption and never caches that order", async () => {
		const pending = deferred<"indeterminate">();
		const root = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		const onMove = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(undefined);
		const core = createAdoptKanbanCore({ source: { onMove } });
		core.adopt(asHTMLElement(root));
		const indeterminate = core.handleDrop({ cardId: "a", targetLaneId: "right", index: 0 });
		const blocked = core.handleDrop({ cardId: "b", targetLaneId: "right", index: 1 });

		pending.resolve("indeterminate");
		await expect(indeterminate).resolves.toBe("indeterminate");
		await expect(blocked).resolves.toBe("indeterminate");
		expect(onMove).toHaveBeenCalledOnce();

		const freshRoot = board([{ id: "left", cards: ["a", "b"] }, { id: "right", cards: ["d"] }]);
		core.adopt(asHTMLElement(freshRoot));
		expect(order(freshRoot, "left")).toEqual(["a", "b"]);
		expect(order(freshRoot, "right")).toEqual(["d"]);
		await expect(core.handleDrop({ cardId: "b", targetLaneId: "right", index: 0 })).resolves.toBe("confirmed");
		expect(onMove).toHaveBeenCalledTimes(2);
	});
});
