import { describe, expect, it } from "vitest";
import {
	computeWeeklyTrackWidth,
	MIN_WEEKLY_COLUMN_WIDTH_PX,
	normalizeWeeklyColumnMinWidth,
} from "../utils/weekly-layout";
import { addCalendarDays, calendarWeekOffset, formatIsoDate, formatPlannerDate, formatPlannerDay, normalizeFrontmatterDate, startOfIsoWeek } from "../utils/scheduled-dates";
import { generateWeekColumns } from "../boards/weeklyOrganiserConfig";
import { clampHorizontalScroll } from "../hooks/useWeeklyBoardLayout";

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

	it("keeps ISO week dates and labels stable without Moment", () => {
    const monday = startOfIsoWeek(new Date(2026, 7, 5));
    expect(formatIsoDate(monday)).toBe("2026-08-03");
    expect(formatPlannerDay(monday)).toBe("Mon 3rd Aug");
    expect(formatPlannerDate(new Date(2026, 8, 7), false, false)).toBe("Sep 7th");
    expect(formatIsoDate(addCalendarDays(monday, 6))).toBe("2026-08-09");
    expect(calendarWeekOffset(addCalendarDays(monday, 7), monday)).toBe(1);
    expect(normalizeFrontmatterDate("2026-08-05T12:30:00+01:00")).toBe("2026-08-05");
    expect(normalizeFrontmatterDate("not a date")).toBeNull();
  });

	it("escapes day notes in column titles", () => {
		const dateId = formatIsoDate(startOfIsoWeek());
		const columns = generateWeekColumns(0, {
			[dateId]: '<img src=x onerror="alert(1)">',
		});
		const title = columns.find((column) => column.id === dateId)?.title;

		expect(title).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(title).not.toContain('<img src=x onerror="alert(1)">');
		expect(title).toContain('class="organiser-column-note has-note"');
	});

	it("ignores an absent scroll host", () => expect(() => clampHorizontalScroll(null)).not.toThrow());

	it.each([
		[100, 100, 4, 0], [200, 100, -1, 0], [200, 100, 101, 100], [200, 100, 50, 50],
	] as const)("clamps horizontal scroll %s/%s from %s", (scrollWidth, clientWidth, scrollLeft, expected) => {
		const element = { scrollWidth, clientWidth, scrollLeft } as HTMLElement;
		clampHorizontalScroll(element);
		expect(element.scrollLeft).toBe(expected);
	});

});
