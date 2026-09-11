import { addCalendarDays, formatIsoDate, formatPlannerDay, startOfIsoWeek } from "../utils/scheduled-dates";
import { BoardConfig, ColumnDefinition } from "../types/kanban-config";

function getDayColumnGridPlacement(dayIndex: number): {
	gridRow: string;
	gridColumn: string;
} {
	if (dayIndex < 4) {
		const columnStart = dayIndex + 2;
		return {
			gridRow: "1 / 2",
			gridColumn: `${columnStart} / ${columnStart + 1}`,
		};
	}
	const columnStart = dayIndex - 2;
	return {
		gridRow: "2 / 3",
		gridColumn: `${columnStart} / ${columnStart + 1}`,
	};
}


export function generateWeekColumns(
	weekOffset: number,
	dayNotes: Record<string, string> = {}
): ColumnDefinition[] {
	const startOfWeek = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
	const today = formatIsoDate(new Date());
	const markedColumn: ColumnDefinition = {
		id: "marked",
		title: "Marked",
		fieldValue: undefined,
		isDefault: true,
		gridRow: "1 / 3",
		gridColumn: "1 / 2",
	};

	const dayColumns: ColumnDefinition[] = [];
	for (let i = 0; i < 7; i++) {
		const date = addCalendarDays(startOfWeek, i);
		const dateId = formatIsoDate(date);
		dayColumns.push({
			id: dateId,
			title: formatPlannerDay(date),
			note: dayNotes[dateId] ?? "",
			fieldValue: dateId,
			className: dateId === today ? "is-today" : undefined,
			...getDayColumnGridPlacement(i),
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
    name: "Weekly Planner",
    columns: generateWeekColumns(weekOffset, dayNotes),
  };
}
