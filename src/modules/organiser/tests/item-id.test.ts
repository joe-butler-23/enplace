import { describe, expect, it } from "vitest";
import { resolveFilePathFromItemId } from "../utils/item-id";

describe("item id resolver", () => {
	it("prefers resolved file path from board entry map", () => {
		expect(
			resolveFilePathFromItemId("recipes/nachos.md::marked", "recipes/nachos.md")
		).toBe("recipes/nachos.md");
	});

	it("strips column suffix from kanban entry ids", () => {
		expect(resolveFilePathFromItemId("recipes/nachos.md::2026-02-19")).toBe(
			"recipes/nachos.md"
		);
	});

	it("returns plain ids unchanged", () => {
		expect(resolveFilePathFromItemId("recipes/nachos.md")).toBe(
			"recipes/nachos.md"
		);
	});
});
