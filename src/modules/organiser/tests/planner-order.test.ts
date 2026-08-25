import { describe, expect, it, vi } from "vitest";
import {
	applyPlannerOrder,
	createEmptyPlannerOrder,
	plannerOrderKey,
	PlannerOrderStore,
	parsePlannerOrder,
} from "../utils/planner-order";

function entry(entryId: string, title: string, type = "recipe") {
	return {
		entryId,
		filePath: entryId.split("::")[0],
		item: { id: entryId, path: entryId, title, type },
		frontmatter: {},
		columnId: entryId.split("::")[1] ?? "marked",
	};
}

describe("planner order", () => {
	it("does not read a missing persisted order", async () => {
		const adapter = {
			exists: vi.fn(async () => false),
			read: vi.fn(),
		};
		const store = new PlannerOrderStore({ vault: { configDir: ".mep", adapter } } as any);

		expect(store.isLoaded()).toBe(false);
		await store.load();
		expect(store.isLoaded()).toBe(true);

		expect(adapter.exists).toHaveBeenCalledWith(".mep/planner-order.json");
		expect(adapter.read).not.toHaveBeenCalled();
		expect(store.get("board", "weekly", "a")).toEqual([]);
	});

	it("loads an existing persisted order", async () => {
		const adapter = {
			exists: vi.fn(async () => true),
			read: vi.fn(async () => JSON.stringify({
				version: 1,
				entries: { [plannerOrderKey("board", "weekly", "a")]: ["a::1"] },
			})),
		};
		const store = new PlannerOrderStore({ vault: { configDir: ".mep", adapter } } as any);

		await store.load();

		expect(adapter.read).toHaveBeenCalledWith(".mep/planner-order.json");
		expect(store.get("board", "weekly", "a")).toEqual(["a::1"]);
	});

	it("falls back to an empty order when an existing file is malformed", async () => {
		const adapter = {
			exists: vi.fn(async () => true),
			read: vi.fn(async () => "not json"),
		};
		const store = new PlannerOrderStore({ vault: { configDir: ".mep", adapter } } as any);

		await store.load();

		expect(adapter.read).toHaveBeenCalledWith(".mep/planner-order.json");
		expect(store.get("board", "weekly", "a")).toEqual([]);
	});

	it("applies persisted order, prunes stale ids, and appends new entries deterministically", () => {
		const entries = [
			entry("b.md::2026-01-01", "Beta"),
			entry("a.md::2026-01-01", "Alpha"),
			entry("c.md::2026-01-01", "Charlie"),
		];

		expect(applyPlannerOrder(entries, ["c.md::2026-01-01", "missing", "a.md::2026-01-01"]).map((e) => e.entryId)).toEqual([
			"c.md::2026-01-01",
			"a.md::2026-01-01",
			"b.md::2026-01-01",
		]);
	});

	it("keeps multi-date occurrences independent", () => {
		const entries = [entry("meal.md::2026-01-01", "Meal"), entry("meal.md::2026-01-02", "Meal")];
		expect(applyPlannerOrder(entries, ["meal.md::2026-01-02"]).map((e) => e.entryId)).toEqual([
			"meal.md::2026-01-02",
			"meal.md::2026-01-01",
		]);
	});

	it("writes all changed columns in one atomic document", async () => {
		let payload = JSON.stringify(createEmptyPlannerOrder());
		const writes: string[] = [];
		const app = {
			vault: {
				configDir: ".mep",
				adapter: {
					exists: vi.fn(async () => true),
					read: vi.fn(async () => payload),
					write: vi.fn(async (_path: string, value: string) => {
						writes.push(value);
						payload = value;
					}),
					mkdir: vi.fn(async () => undefined),
					rename: vi.fn(async (_from: string, _to: string) => undefined),
					remove: vi.fn(async () => undefined),
				},
			},
		} as any;
		const store = new PlannerOrderStore(app);
		await store.replaceMany(
			new Map([
			[plannerOrderKey("board", "weekly", "a"), ["a::1", "a::2"]],
			[plannerOrderKey("board", "weekly", "b"), ["b::1"]],
			])
		);
		const document = JSON.parse(writes.at(-1) ?? "{}");
		expect(document.entries[plannerOrderKey("board", "weekly", "a")]).toEqual(["a::1", "a::2"]);
		expect(document.entries[plannerOrderKey("board", "weekly", "b")]).toEqual(["b::1"]);
		expect(app.vault.adapter.rename).toHaveBeenCalledWith(
		".mep/planner-order.json.tmp",
		".mep/planner-order.json"
		);
	});

	it("rejects malformed persisted documents", () => {
		expect(parsePlannerOrder({ version: 99, entries: { a: ["x"] } })).toEqual(createEmptyPlannerOrder());
	});

	it("rolls back the in-memory order when the atomic write fails", async () => {
		const app = {
			vault: {
				configDir: ".mep",
				adapter: {
					exists: vi.fn(async () => true),
					read: vi.fn(async () => JSON.stringify(createEmptyPlannerOrder())),
					write: vi.fn(async () => undefined),
					mkdir: vi.fn(async () => undefined),
					rename: vi.fn(async () => {
						throw new Error("disk full");
					}),
					remove: vi.fn(async () => undefined),
				},
			},
		} as any;
		const store = new PlannerOrderStore(app);
		await expect(store.replace("board", "weekly", "a", ["a::1"])).rejects.toThrow("disk full");
		expect(store.get("board", "weekly", "a")).toEqual([]);
	});
});
