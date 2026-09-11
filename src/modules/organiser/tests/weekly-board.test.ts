import { describe, expect, it } from "vitest";
import { addCalendarDays, calendarWeekOffset, formatIsoDate, formatPlannerDate, formatPlannerDay, normalizeFrontmatterDate, startOfIsoWeek } from "../utils/scheduled-dates";
import { generateWeekColumns } from "../boards/weeklyOrganiserConfig";

describe("weekly board dates and columns", () => {
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

	it("carries day notes and titles as plain text and marks only today", () => {
		const dateId = formatIsoDate(startOfIsoWeek());
		const note = '<img src=x onerror="alert(1)">';
		const columns = generateWeekColumns(0, { [dateId]: note });
		const day = columns.find((column) => column.id === dateId);

		expect(day?.note).toBe(note);
		expect(day?.title).toBe(formatPlannerDay(startOfIsoWeek()));
		expect(columns.find((column) => column.id === "marked")?.note).toBeUndefined();
		expect(columns.filter((column) => column.className === "is-today").map((column) => column.id))
			.toEqual([formatIsoDate(new Date())]);
		expect(generateWeekColumns(1).some((column) => column.className === "is-today")).toBe(false);
	});

});
