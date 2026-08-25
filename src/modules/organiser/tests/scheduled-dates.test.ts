import { describe, expect, it } from "vitest";
import {
	readScheduledDateList,
	writeScheduledDateList,
} from "../utils/scheduled-dates";

describe("scheduled date utilities", () => {
	it("reads and normalizes scheduled values from all supported fields", () => {
		const frontmatter = {
			scheduledDates: ["2026-02-12", "2026-02-10"],
			scheduled: "2026-02-11",
			date: "2026-02-09",
		};
		expect(readScheduledDateList(frontmatter)).toEqual([
			"2026-02-09",
			"2026-02-10",
			"2026-02-11",
			"2026-02-12",
		]);
	});

	it("writes scalar scheduled value when there is one date", () => {
		const frontmatter: Record<string, unknown> = {
			scheduledDates: ["2026-02-10", "2026-02-11"],
			date: "2026-02-09",
		};
		writeScheduledDateList(frontmatter, ["2026-02-13"]);
		expect(frontmatter).toEqual({
			scheduled: "2026-02-13",
		});
	});

	it("writes scheduledDates list when there are multiple dates", () => {
		const frontmatter: Record<string, unknown> = {};
		writeScheduledDateList(frontmatter, ["2026-02-14", "2026-02-12"]);
		expect(frontmatter).toEqual({
			scheduled: "2026-02-12",
			scheduledDates: ["2026-02-12", "2026-02-14"],
		});
	});

	it("clears scheduling fields when no dates are provided", () => {
		const frontmatter: Record<string, unknown> = {
			scheduled: "2026-02-12",
			scheduledDates: ["2026-02-12", "2026-02-14"],
			date: "2026-02-12",
		};
		writeScheduledDateList(frontmatter, []);
		expect(frontmatter).toEqual({});
	});
});
