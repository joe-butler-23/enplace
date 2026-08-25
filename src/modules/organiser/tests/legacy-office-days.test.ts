import { describe, expect, it } from "vitest";
import { createWeeklyOrganiserConfig, generateWeekColumns } from "../boards/weeklyOrganiserConfig";
import { findPresetById, getOrganiserPresets } from "../presets/organiserPresets";

const WEEKLY_ORGANISER_PRESET = findPresetById(getOrganiserPresets(), "weekly");

// Legacy-vault regression: a vault that still contains `_mep/office-days`
// content (from the removed office-day feature) must load cleanly and show
// no office-day cards. The board simply ignores that folder.

type FakeFile = { basename: string; path: string };

function makeFile(path: string): FakeFile {
	return {
		basename: path.split("/").pop() ?? path,
		path,
	};
}

const LEGACY_TEMPLATE_FILES: FakeFile[] = [
	makeFile("_mep/office-days/templates/jamie-office-day.md"),
	makeFile("_mep/office-days/templates/alex-office-day.md"),
];

const LEGACY_INSTANCE_FILES: FakeFile[] = [
	makeFile("_mep/office-days/items/alex-office-day-2026-08-25.md"),
];

describe("legacy _mep/office-days vault content is ignored", () => {
	const config = createWeeklyOrganiserConfig(0, WEEKLY_ORGANISER_PRESET);
	const customFilter = config.itemFilter?.customFilter;

	it("filters out legacy office-day template and instance notes", () => {
		expect(customFilter).toBeDefined();
		for (const file of [...LEGACY_TEMPLATE_FILES, ...LEGACY_INSTANCE_FILES]) {
			expect(customFilter!(file as never, { type: "reminder" })).toBe(false);
			expect(
				customFilter!(file as never, {
					type: "reminder",
					title: "Alex Office Day",
					marked: true,
				})
			).toBe(false);
		}
	});

	it("keeps ordinary reminders and recipes visible alongside legacy content", () => {
		const reminder = makeFile("events/groceries.md");
		expect(customFilter!(reminder as never, { type: "reminder", scheduled: "2026-08-25" })).toBe(true);

		const recipe = makeFile("recipes/soup.md");
		expect(customFilter!(recipe as never, { type: "recipe", marked: true })).toBe(true);

		const item = config.itemTransformer?.(reminder as never, {
			type: "reminder",
			title: "Groceries",
			scheduled: "2026-08-25",
		});
		expect(item).toMatchObject({ title: "Groceries", type: "reminder" });
		expect(item && "isOffice" in item).toBe(false);
	});

	it("renders no marked-mode selector in the column header", () => {
		const columns = generateWeekColumns(0);
		const marked = columns.find((column) => column.id === "marked");
		expect(marked?.title).toBe("Marked");
	});
});
