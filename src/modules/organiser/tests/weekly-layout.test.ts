import { describe, expect, it } from "vitest";
import {
	computeWeeklyTrackWidth,
	MIN_WEEKLY_COLUMN_WIDTH_PX,
	normalizeWeeklyColumnMinWidth,
} from "../utils/weekly-layout";
import { moment } from "@/platform";
import { generateWeekColumns } from "../boards/weeklyOrganiserConfig";

describe("weekly layout sizing", () => {
	it("clamps the persisted minimum width to 200px+", () => {
		expect(normalizeWeeklyColumnMinWidth(120)).toBe(MIN_WEEKLY_COLUMN_WIDTH_PX);
		expect(normalizeWeeklyColumnMinWidth(Number.NaN)).toBe(MIN_WEEKLY_COLUMN_WIDTH_PX);
		expect(normalizeWeeklyColumnMinWidth(240.4)).toBe(240);
	});

	it("uses the minimum width when viewport is too narrow", () => {
		const minWidth = 220;
		// (900 - 48) / 5 = 170.4, so tracks should stay at min width.
		expect(computeWeeklyTrackWidth(900, minWidth)).toBe(minWidth);
	});

	it("expands all columns equally when there is extra space", () => {
		// (1508 - 48) / 5 = 292
		expect(computeWeeklyTrackWidth(1508, 200)).toBe(292);
	});

	it("falls back to minimum width when host width is unavailable", () => {
		expect(computeWeeklyTrackWidth(0, 260)).toBe(260);
	});

	it("escapes day notes in column titles", () => {
		const dateId = moment().startOf("isoWeek").format("YYYY-MM-DD");
		const columns = generateWeekColumns(0, {
			[dateId]: '<img src=x onerror="alert(1)">',
		});
		const title = columns.find((column) => column.id === dateId)?.title;

		expect(title).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(title).not.toContain('<img src=x onerror="alert(1)">');
		expect(title).toContain('class="organiser-column-note has-note"');
	});
});
