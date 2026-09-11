import { addCalendarDays, formatIsoDate, formatPlannerDay, startOfIsoWeek } from "../utils/scheduled-dates";
import { BoardConfig, ColumnDefinition } from "../types/kanban-config";

export function generateWeekColumns(
	weekOffset: number,
	dayNotes: Record<string, string> = {}
): ColumnDefinition[] {
	const startOfWeek = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
	const today = formatIsoDate(new Date());
	const markedColumn: ColumnDefinition = {
		id: "marked",
		title: "Marked",
		isDefault: true,
	};

	const dayColumns: ColumnDefinition[] = [];
	for (let i = 0; i < 7; i++) {
		const date = addCalendarDays(startOfWeek, i);
		const dateId = formatIsoDate(date);
		dayColumns.push({
			id: dateId,
			title: formatPlannerDay(date),
			note: dayNotes[dateId] ?? "",
			className: dateId === today ? "is-today" : undefined,
		});
	}

	return [markedColumn, ...dayColumns];
}

export function createWeeklyOrganiserConfig(
  weekOffset: number,
  dayNotes: Record<string, string> = {},
): BoardConfig {
  return {
    id: "weekly-organiser",
    columns: generateWeekColumns(weekOffset, dayNotes),
  };
}
