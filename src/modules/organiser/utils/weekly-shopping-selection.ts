import type { OrganiserItem } from "../types";
import { isIsoDateString } from "./scheduled-dates";

export function selectWeeklyShoppingRecipePaths(
	entries: Iterable<{
		filePath: string;
		item: Pick<OrganiserItem, "date">;
	}>,
	weekStartDate: string,
	weekEndDate: string
): string[] {
	const recipePaths: string[] = [];
	for (const entry of entries) {
		const scheduledDate = entry.item.date;
		if (
			isIsoDateString(scheduledDate) &&
			scheduledDate >= weekStartDate &&
			scheduledDate <= weekEndDate
		) {
			recipePaths.push(entry.filePath);
		}
	}
	return recipePaths;
}
