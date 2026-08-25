import { describe, expect, it } from "vitest";
import { removeRecipeScheduledDateOccurrence } from "../utils/recipe-schedule-actions";

describe("recipe schedule actions", () => {
	it("removes a single scheduled date and keeps remaining duplicates", () => {
		const frontmatter: Record<string, unknown> = {
			scheduled: "2026-02-16",
			scheduledDates: ["2026-02-16", "2026-02-17"],
			marked: true,
		};

		const result = removeRecipeScheduledDateOccurrence(frontmatter, "2026-02-16");

		expect(result).toEqual({
			removedSourceDate: true,
			remainingDates: ["2026-02-17"],
			marked: false,
		});
		expect(frontmatter).toEqual({
			scheduled: "2026-02-17",
		});
	});

	it("marks unscheduled recipe when the final scheduled date is removed", () => {
		const frontmatter: Record<string, unknown> = {
			scheduled: "2026-02-16",
		};

		const result = removeRecipeScheduledDateOccurrence(frontmatter, "2026-02-16");

		expect(result).toEqual({
			removedSourceDate: true,
			remainingDates: [],
			marked: true,
		});
		expect(frontmatter).toEqual({
			marked: true,
		});
	});

	it("can remove final scheduled date without marking", () => {
		const frontmatter: Record<string, unknown> = {
			scheduled: "2026-02-16",
			marked: true,
		};

		const result = removeRecipeScheduledDateOccurrence(frontmatter, "2026-02-16", {
			markWhenEmpty: false,
		});

		expect(result).toEqual({
			removedSourceDate: true,
			remainingDates: [],
			marked: false,
		});
		expect(frontmatter).toEqual({});
	});
});
