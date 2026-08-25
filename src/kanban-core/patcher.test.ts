import { describe, expect, it, vi } from "vitest";
import type { KanbanCardData } from "./lifecycle";
import { createBoardPatcher, type KanbanLanePatch } from "./patcher";
import { CONTRACT_SELECTORS, JKANBAN_SELECTORS } from "./selectors";

// Vitest's default environment here is "node" (see vitest.config.ts) and
// neither jsdom nor happy-dom is installed, so DOM-level patcher tests run
// against a minimal, purpose-built fake DOM rather than a real one. It
// implements exactly what the patcher and its selector maps touch:
// classList/dataset/attributes, tree mutation (appendChild/insertBefore/
// remove/replaceWith), and a tiny querySelector(All) supporting the compound
// class+attribute selectors the contract and jKanban presets use (no
// combinators are needed since every selector here is a single compound
// selector).

class FakeElement {
	readonly tagName: string;
	readonly classNames = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly queryCounts = new Map<string, number>();
	children: FakeElement[] = [];
	parentNode: FakeElement | null = null;
	private html = "";

	constructor(tagName = "div") {
		this.tagName = tagName;
	}

	get classList() {
		const self = this;
		return {
			add: (...names: string[]) => {
				for (const name of names) if (name) self.classNames.add(name);
			},
			remove: (...names: string[]) => {
				for (const name of names) self.classNames.delete(name);
			},
			contains: (name: string) => self.classNames.has(name),
			[Symbol.iterator]: () => self.classNames.values(),
		};
	}

	get className(): string {
		return Array.from(this.classNames).join(" ");
	}

	get dataset(): Record<string, string | undefined> {
		const self = this;
		return new Proxy(
			{},
			{
				get(_target, prop: string) {
					return self.attrs.get(`data-${toKebabCase(prop)}`);
				},
				set(_target, prop: string, value: string) {
					self.attrs.set(`data-${toKebabCase(prop)}`, value);
					return true;
				},
			}
		) as Record<string, string | undefined>;
	}

	get innerHTML(): string {
		return this.html;
	}

	set innerHTML(value: string) {
		this.html = value;
	}

	getAttribute(name: string): string | null {
		return this.attrs.has(name) ? this.attrs.get(name)! : null;
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	appendChild(child: FakeElement): FakeElement {
		child.parentNode?.detach(child);
		this.children.push(child);
		child.parentNode = this;
		return child;
	}

	insertBefore(newNode: FakeElement, referenceNode: FakeElement | null): FakeElement {
		newNode.parentNode?.detach(newNode);
		if (referenceNode) {
			const index = this.children.indexOf(referenceNode);
			this.children.splice(index === -1 ? this.children.length : index, 0, newNode);
		} else {
			this.children.push(newNode);
		}
		newNode.parentNode = this;
		return newNode;
	}

	detach(child: FakeElement): void {
		const index = this.children.indexOf(child);
		if (index !== -1) this.children.splice(index, 1);
	}

	remove(): void {
		this.parentNode?.detach(this);
		this.parentNode = null;
	}

	replaceWith(newNode: FakeElement): void {
		const parent = this.parentNode;
		if (!parent) return;
		const index = parent.children.indexOf(this);
		if (index === -1) return;
		parent.children[index] = newNode;
		newNode.parentNode = parent;
		this.parentNode = null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		this.queryCounts.set(selector, (this.queryCounts.get(selector) ?? 0) + 1);
		const matches = compileSelector(selector);
		const results: FakeElement[] = [];
		const walk = (el: FakeElement) => {
			for (const child of el.children) {
				if (matches(child)) results.push(child);
				walk(child);
			}
		};
		walk(this);
		return results;
	}

	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

function toKebabCase(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function compileSelector(selector: string): (el: FakeElement) => boolean {
	const classNames: string[] = [];
	const attrChecks: Array<{ name: string; value?: string }> = [];
	const tokenPattern = /\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(selector))) {
		if (match[1]) classNames.push(match[1]);
		else if (match[2]) attrChecks.push({ name: match[2], value: match[3] });
	}
	return (el) => {
		for (const className of classNames) if (!el.classNames.has(className)) return false;
		for (const check of attrChecks) {
			if (!el.attrs.has(check.name)) return false;
			if (check.value !== undefined && el.attrs.get(check.name) !== check.value) return false;
		}
		return true;
	};
}

function asHTMLElement(el: FakeElement): HTMLElement {
	return el as unknown as HTMLElement;
}

// Contract-shaped fixture: a container with two lanes, each carrying a
// `[data-kanban-cards]` list of `[data-kanban-card]` elements.
function buildContractContainer(lanes: Array<{ id: string; cardIds: string[] }>) {
	const container = new FakeElement("div");
	for (const lane of lanes) {
		const laneEl = new FakeElement("section");
		laneEl.setAttribute("data-kanban-lane", lane.id);
		const cardsEl = new FakeElement("ol");
		cardsEl.setAttribute("data-kanban-cards", "");
		for (const cardId of lane.cardIds) {
			const cardEl = new FakeElement("li");
			cardEl.setAttribute("data-kanban-card", cardId);
			cardEl.innerHTML = `card ${cardId}`;
			cardsEl.appendChild(cardEl);
		}
		laneEl.appendChild(cardsEl);
		container.appendChild(laneEl);
	}
	return container;
}

function buildCard(overrides: Partial<KanbanCardData> = {}): KanbanCardData {
	return { id: "a", html: "<span>a</span>", classes: ["card"], ...overrides };
}

function contractBuildCardElement(card: KanbanCardData): HTMLElement {
	const el = new FakeElement("li");
	for (const className of card.classes ?? []) el.classList.add(className);
	el.setAttribute("data-kanban-card", card.id);
	if (card.elementTimingIdentifier) {
		el.setAttribute("elementtiming", card.elementTimingIdentifier);
	}
	el.innerHTML = card.html;
	return asHTMLElement(el);
}

function contractLane(id: string, cardIds: string[]): KanbanLanePatch {
	return {
		id,
		cards: cardIds.map((cardId) => ({ id: cardId, html: `card ${cardId}`, classes: [] })),
	};
}

describe("createBoardPatcher", () => {
	it("is a no-op when the lane data snapshot is unchanged", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const lanes: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" }), buildCard({ id: "b" })] },
		];

		const firstPass = patcher.patchLanes(lanes);
		expect(firstPass).toEqual(["lane-1"]);

		const cardsBefore = container.querySelectorAll("[data-kanban-card]").map((el) => el);
		container.queryCounts.clear();
		const secondPass = patcher.patchLanes(lanes);
		expect(secondPass).toEqual([]);
		expect(container.queryCounts.get(CONTRACT_SELECTORS.card)).toBeUndefined();
		const cardsAfter = container.querySelectorAll("[data-kanban-card]").map((el) => el);
		expect(cardsAfter).toEqual(cardsBefore);
	});

	it("treats the Element Timing identifier as card presentation state", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: [] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const first = [{
			id: "lane-1",
			cards: [buildCard({ id: "a", elementTimingIdentifier: "mep:planner-card:a" })],
		}];
		expect(patcher.patchLanes(first)).toEqual(["lane-1"]);
		expect(container.querySelector("[data-kanban-card]")?.getAttribute("elementtiming"))
			.toBe("mep:planner-card:a");

		const second = [{ id: "lane-1", cards: [buildCard({ id: "a" })] }];
		expect(patcher.patchLanes(second)).toEqual(["lane-1"]);
		expect(container.querySelector("[data-kanban-card]")?.getAttribute("elementtiming"))
			.toBeNull();
	});

	it("reconciles invalidated same-lane DOM drift against unchanged authoritative data", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const authoritative = [contractLane("lane-1", ["a", "b"])];
		patcher.snapshotFromDom();

		const cards = container.querySelector("[data-kanban-cards]")!;
		const firstCard = cards.children[0];
		cards.appendChild(firstCard);
		expect(cards.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["b", "a"]);

		patcher.invalidateLanes(["lane-1"]);
		expect(patcher.patchLanes(authoritative)).toEqual(["lane-1"]);
		expect(cards.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["a", "b"]);
		expect(cards.children[0]).toBe(firstCard);

		container.queryCounts.clear();
		expect(patcher.patchLanes(authoritative)).toEqual([]);
		expect(container.queryCounts.get(CONTRACT_SELECTORS.card)).toBeUndefined();
	});

	it("reconciles invalidated cross-lane DOM drift against unchanged authoritative data", () => {
		const container = buildContractContainer([
			{ id: "lane-1", cardIds: ["a", "b"] },
			{ id: "lane-2", cardIds: ["c"] },
		]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const authoritative = [
			contractLane("lane-1", ["a", "b"]),
			contractLane("lane-2", ["c"]),
		];
		patcher.snapshotFromDom();

		const [source, target] = container.querySelectorAll("[data-kanban-cards]");
		const movedCard = source.children[0];
		target.appendChild(movedCard);
		expect(source.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["b"]);
		expect(target.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["c", "a"]);

		patcher.invalidateLanes(new Set(["lane-1", "lane-2"]));
		expect(patcher.patchLanes(authoritative)).toEqual(["lane-1", "lane-2"]);
		expect(source.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["a", "b"]);
		expect(target.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["c"]);
		expect(source.children[0]).toBe(movedCard);
	});

	it("removes a rejected cross-lane rekey without leaving an orphan or duplicate", () => {
		const container = buildContractContainer([
			{ id: "lane-1", cardIds: ["a"] },
			{ id: "lane-2", cardIds: [] },
		]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const authoritative = [
			contractLane("lane-1", ["a"]),
			contractLane("lane-2", []),
		];
		patcher.snapshotFromDom();

		const [source, target] = container.querySelectorAll("[data-kanban-cards]");
		const movedCard = source.children[0];
		target.appendChild(movedCard);
		patcher.rekeyCard(asHTMLElement(movedCard), "lane-2::a");
		expect(movedCard.getAttribute("data-kanban-card")).toBe("lane-2::a");

		patcher.invalidateLanes(["lane-1", "lane-2"]);
		expect(patcher.patchLanes(authoritative)).toEqual(["lane-1", "lane-2"]);
		expect(source.children.map((card) => card.getAttribute("data-kanban-card"))).toEqual(["a"]);
		expect(target.children).toEqual([]);
		expect(container.querySelectorAll("[data-kanban-card]").map((card) => (
			card.getAttribute("data-kanban-card")
		))).toEqual(["a"]);
		expect(movedCard.parentNode).toBeNull();
	});

	it("does not confuse card data containing snapshot delimiters", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: [] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.patchLanes([
			{
				id: "lane-1",
				cards: [{ id: "a", html: "x", classes: ["y|b:z:"] }],
			},
		]);

		const changed = patcher.patchLanes([
			{
				id: "lane-1",
				cards: [
					{ id: "a", html: "x", classes: ["y"] },
					{ id: "b", html: "z", classes: [] },
				],
			},
		]);

		expect(changed).toEqual(["lane-1"]);
		const cardsEl = container.querySelector("[data-kanban-cards]")!;
		expect(cardsEl.children.map((element) => element.getAttribute("data-kanban-card"))).toEqual(["a", "b"]);
	});

	it("replaces only the changed card in the same-order fast path", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const initial: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" }), buildCard({ id: "b" })] },
		];
		patcher.patchLanes(initial);

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const unchangedNode = cardsEl.children[0];

		const updated: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [buildCard({ id: "a" }), buildCard({ id: "b", html: "<span>b2</span>" })],
			},
		];
		const changed = patcher.patchLanes(updated);

		expect(changed).toEqual(["lane-1"]);
		expect(cardsEl.children[0]).toBe(unchangedNode); // untouched card keeps its node
		expect(cardsEl.children.map((el) => el.getAttribute("data-kanban-card"))).toEqual(["a", "b"]);
		expect(cardsEl.children[1].innerHTML).toBe("<span>b2</span>");
	});

	it("reorders while preserving node identity for every unchanged card", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b", "c"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const initial: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [buildCard({ id: "a" }), buildCard({ id: "b" }), buildCard({ id: "c" })],
			},
		];
		patcher.patchLanes(initial);

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const nodesById = new Map(cardsEl.children.map((el) => [el.getAttribute("data-kanban-card"), el]));

		const reordered: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [buildCard({ id: "c" }), buildCard({ id: "a" }), buildCard({ id: "b" })],
			},
		];
		const changed = patcher.patchLanes(reordered);

		expect(changed).toEqual(["lane-1"]);
		const idsAfter = cardsEl.children.map((el) => el.getAttribute("data-kanban-card"));
		expect(idsAfter).toEqual(["c", "a", "b"]);
		for (const el of cardsEl.children) {
			expect(el).toBe(nodesById.get(el.getAttribute("data-kanban-card")));
		}
	});

	it("indexes card nodes once per reconciliation", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b", "c"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const initial: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [buildCard({ id: "a" }), buildCard({ id: "b" }), buildCard({ id: "c" })],
			},
		];
		patcher.patchLanes(initial);
		container.queryCounts.clear();

		patcher.patchLanes([
			{
				...initial[0],
				cards: initial[0].cards.map((card) => ({ ...card, html: `${card.html} updated` })),
			},
		]);

		expect(container.queryCounts.get(CONTRACT_SELECTORS.card)).toBe(1);
	});

	it("adds new cards and removes dropped ones", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const initial: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" }), buildCard({ id: "b" })] },
		];
		patcher.patchLanes(initial);

		const next: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "b" }), buildCard({ id: "c" })] },
		];
		const changed = patcher.patchLanes(next);

		expect(changed).toEqual(["lane-1"]);
		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const ids = cardsEl.children.map((el) => el.getAttribute("data-kanban-card"));
		expect(ids).toEqual(["b", "c"]);
	});

	it("snapshotFromDom seeds state from existing DOM so the first patch against unchanged data is a no-op", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		// No initial patchLanes call: this simulates ptt-dash's adopt mode,
		// indexing DOM the server already rendered.
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});

		patcher.snapshotFromDom();

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const nodesBefore = [...cardsEl.children];

		// The DOM already carries exactly this data (card html is "card <id>",
		// no extra classes) — a subsequent patch must not touch the DOM.
		const lanes: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [
					{ id: "a", html: "card a", classes: [] },
					{ id: "b", html: "card b", classes: [] },
				],
			},
		];
		const changed = patcher.patchLanes(lanes);

		expect(changed).toEqual([]);
		expect(cardsEl.children).toEqual(nodesBefore);
	});

	it("keeps structural jKanban classes outside canonical card data", () => {
		const container = new FakeElement("div");
		const laneEl = new FakeElement("div");
		laneEl.classList.add("kanban-board");
		laneEl.setAttribute("data-id", "todo");
		const cardsEl = new FakeElement("main");
		cardsEl.classList.add("kanban-drag");
		const cardEl = new FakeElement("div");
		cardEl.classList.add("kanban-item");
		cardEl.classList.add("organiser-card--recipe-card");
		(cardEl as unknown as HTMLElement).dataset.eid = "recipe-1";
		cardEl.innerHTML = "<strong>Soup</strong>";
		cardsEl.appendChild(cardEl);
		laneEl.appendChild(cardsEl);
		container.appendChild(laneEl);

		function buildJKanbanCardElement(card: KanbanCardData): HTMLElement {
			const el = new FakeElement("div");
			el.classList.add("kanban-item");
			for (const className of card.classes ?? []) el.classList.add(className);
			(el as unknown as HTMLElement).dataset.eid = card.id;
			el.innerHTML = card.html;
			return asHTMLElement(el);
		}

		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: JKANBAN_SELECTORS,
			buildCardElement: buildJKanbanCardElement,
		});
		patcher.snapshotFromDom();

		const lanes: KanbanLanePatch[] = [
			{
				id: "todo",
				cards: [{ id: "recipe-1", html: "<strong>Soup</strong>", classes: ["organiser-card--recipe-card"] }],
			},
		];
		const changed = patcher.patchLanes(lanes);

		expect(changed).toEqual([]);
		expect(cardsEl.children[0]).toBe(cardEl);
	});

	it("invokes onLanesRendered once per patch with only the changed lane ids and their elements", () => {
		const container = buildContractContainer([
			{ id: "lane-1", cardIds: ["a"] },
			{ id: "lane-2", cardIds: ["x"] },
		]);
		const onLanesRendered = vi.fn();
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
			onLanesRendered,
		});
		const initial: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" })] },
			{ id: "lane-2", cards: [buildCard({ id: "x" })] },
		];
		patcher.patchLanes(initial);
		expect(onLanesRendered).toHaveBeenCalledTimes(1);
		const [firstIds, firstElements] = onLanesRendered.mock.calls[0];
		expect(new Set(firstIds)).toEqual(new Set(["lane-1", "lane-2"]));
		expect(firstElements.get("lane-1")).toBeTruthy();
		expect(firstElements.get("lane-2")).toBeTruthy();

		onLanesRendered.mockClear();
		// Same data: no-op patch, hook must not fire again.
		patcher.patchLanes(initial);
		expect(onLanesRendered).not.toHaveBeenCalled();

		const onlyLaneTwoChanged: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" })] },
			{ id: "lane-2", cards: [buildCard({ id: "x", html: "<span>x2</span>" })] },
		];
		patcher.patchLanes(onlyLaneTwoChanged);
		expect(onLanesRendered).toHaveBeenCalledTimes(1);
		const [secondIds] = onLanesRendered.mock.calls[0];
		expect(secondIds).toEqual(["lane-2"]);
	});

	it("replaces a card's content in place, preserving node identity (mise-en-place-983)", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const initial: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" }), buildCard({ id: "b" })] },
		];
		patcher.patchLanes(initial);

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const nodeBefore = cardsEl.children[1];

		const updated: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [buildCard({ id: "a" }), buildCard({ id: "b", html: "<span>b2</span>" })],
			},
		];
		patcher.patchLanes(updated);

		// Same element reference before and after: node identity is preserved
		// across a content-change patch (no replaceWith node swap).
		expect(cardsEl.children[1]).toBe(nodeBefore);
		expect(cardsEl.children[1].innerHTML).toBe("<span>b2</span>");
	});

	it("reconciles classes to exactly the new set on an in-place replace (mise-en-place-983)", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.patchLanes([
			{ id: "lane-1", cards: [buildCard({ id: "a", classes: ["card", "stale"] })] },
		]);

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const node = cardsEl.children[0];
		expect(Array.from(node.classList).sort()).toEqual(["card", "stale"]);

		patcher.patchLanes([
			{
				id: "lane-1",
				cards: [buildCard({ id: "a", html: "<span>a2</span>", classes: ["card", "fresh"] })],
			},
		]);

		expect(cardsEl.children[0]).toBe(node); // still the same node
		expect(Array.from(node.classList).sort()).toEqual(["card", "fresh"]); // stale gone, fresh added
	});

	it("rekeyCard followed by an identical patch is a clean no-op (mise-en-place-983)", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		const initial: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a" }), buildCard({ id: "b" })] },
		];
		patcher.patchLanes(initial);

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const nodeBefore = cardsEl.children[0];

		patcher.rekeyCard(asHTMLElement(nodeBefore), "a2");
		expect(nodeBefore.getAttribute("data-kanban-card")).toBe("a2");

		const renamed: KanbanLanePatch[] = [
			{ id: "lane-1", cards: [buildCard({ id: "a2" }), buildCard({ id: "b" })] },
		];
		const changed = patcher.patchLanes(renamed);

		expect(changed).toEqual([]);
		expect(cardsEl.children[0]).toBe(nodeBefore);
	});

	it("rekeys the exact Dragula copy without touching its source card", () => {
		const container = buildContractContainer([
			{ id: "lane-1", cardIds: ["a"] },
			{ id: "lane-2", cardIds: [] },
		]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.snapshotFromDom();

		const source = container.querySelector("[data-kanban-card]")!;
		const targetCards = container.querySelectorAll("[data-kanban-cards]")[1];
		const clone = new FakeElement("li");
		clone.setAttribute("data-kanban-card", "a");
		clone.innerHTML = "card a";
		targetCards.appendChild(clone);

		patcher.rekeyCard(asHTMLElement(clone), "a-copy");

		expect(source.getAttribute("data-kanban-card")).toBe("a");
		expect(clone.getAttribute("data-kanban-card")).toBe("a-copy");
		expect(patcher.patchLanes([
			{ id: "lane-1", cards: [{ id: "a", html: "card a", classes: [] }] },
			{ id: "lane-2", cards: [{ id: "a-copy", html: "card a", classes: [] }] },
		])).toEqual(["lane-2"]);
	});

	it("adopt mode preflights changed and missing cards before mutation", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a", "b"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			// No buildCardElement: adopt mode — the server already rendered this DOM.
		});
		patcher.snapshotFromDom();

		const laneEl = container.querySelectorAll("[data-kanban-lane]")[0];
		const cardsEl = laneEl.querySelector("[data-kanban-cards]")!;
		const nodeA = cardsEl.children[0];

		const contentChange: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [
					{ id: "a", html: "<span>a2</span>", classes: [] },
					{ id: "b", html: "card b", classes: [] },
				],
			},
		];
		expect(() => patcher.patchLanes(contentChange)).toThrow('Kanban patch requires buildCardElement for card "a"');
		expect(cardsEl.children[0]).toBe(nodeA);
		expect(cardsEl.children[0].innerHTML).toBe("card a");

		const withNewCard: KanbanLanePatch[] = [
			{
				id: "lane-1",
				cards: [
					{ id: "a", html: "card a", classes: [] },
					{ id: "b", html: "card b", classes: [] },
					{ id: "c", html: "card c", classes: [] },
				],
			},
		];
		expect(() => patcher.patchLanes(withNewCard)).toThrow('Kanban patch requires buildCardElement for card "c"');
		expect(cardsEl.children.map((element) => element.getAttribute("data-kanban-card"))).toEqual(["a", "b"]);
	});

	it("rejects patches for lanes outside the static board topology", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: [] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.snapshotFromDom();

		expect(() => patcher.patchLanes([
			{ id: "missing", cards: [buildCard()] },
		])).toThrow('Kanban patch references unknown lane "missing"');
	});

	it("rejects duplicate lane ids before touching the DOM", () => {
		const container = buildContractContainer([{ id: "lane-1", cardIds: ["a"] }]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.snapshotFromDom();
		container.queryCounts.clear();

		expect(() => patcher.patchLanes([
			{ id: "lane-1", cards: [buildCard({ id: "a" })] },
			{ id: "lane-1", cards: [] },
		])).toThrow('Kanban patch contains duplicate lane id "lane-1"');
		expect(container.queryCounts.size).toBe(0);
	});

	it("rejects a partial patch that duplicates a card in an untouched lane", () => {
		const container = buildContractContainer([
			{ id: "lane-1", cardIds: ["a"] },
			{ id: "lane-2", cardIds: [] },
		]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.snapshotFromDom();

		expect(() => patcher.patchLanes([
			{ id: "lane-2", cards: [{ id: "a", html: "card a", classes: [] }] },
		])).toThrow('Kanban patch contains duplicate card id "a"');
		expect(container.querySelectorAll("[data-kanban-cards]").map((cards) => (
			cards.children.map((card) => card.getAttribute("data-kanban-card"))
		))).toEqual([["a"], []]);
	});

	it("rejects rekeying a new Dragula clone to an id retained by cached state", () => {
		const container = buildContractContainer([
			{ id: "lane-1", cardIds: ["a"] },
			{ id: "lane-2", cardIds: ["b"] },
		]);
		const patcher = createBoardPatcher({
			container: asHTMLElement(container),
			selectors: CONTRACT_SELECTORS,
			buildCardElement: contractBuildCardElement,
		});
		patcher.snapshotFromDom();

		container.querySelectorAll("[data-kanban-card]")[1].remove();
		const clone = new FakeElement("li");
		clone.setAttribute("data-kanban-card", "a");
		container.querySelectorAll("[data-kanban-cards]")[1].appendChild(clone);

		expect(() => patcher.rekeyCard(asHTMLElement(clone), "b"))
			.toThrow('Kanban state already contains card id "b"');
		expect(clone.getAttribute("data-kanban-card")).toBe("a");
	});
});
