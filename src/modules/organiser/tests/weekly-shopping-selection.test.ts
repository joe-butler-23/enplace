import { describe, expect, it } from "vitest";
import { selectWeeklyShoppingRecipePaths } from "../utils/weekly-shopping-selection";

describe("weekly shopping recipe selection", () => {
	it("includes only recipes scheduled during the displayed week", () => {
		const recipePaths = selectWeeklyShoppingRecipePaths(
			[
				{
					filePath: "Recipes/marked.md",
					item: { type: "recipe", date: "marked" },
				},
				{
					filePath: "Recipes/current-week.md",
					item: { type: "recipe", date: "2026-08-05" },
				},
				{
					filePath: "Recipes/next-week.md",
					item: { type: "recipe", date: "2026-08-12" },
				},
			],
			"2026-08-03",
			"2026-08-09"
		);

		expect(recipePaths).toEqual(["Recipes/current-week.md"]);
	});
});
