import { moment } from "@/platform";

export const FRONTMATTER_DATE_FORMATS = [
	"YYYY-MM-DD",
	"YYYY-MM-DDTHH:mm:ssZ",
	"YYYY-MM-DDTHH:mm:ss.SSSZ",
	"ddd, DD MMM YYYY HH:mm:ss ZZ",
];

export function isIsoDateString(
	value: string | null | undefined
): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function normalizeFrontmatterDate(
	value: unknown,
	{ format = "YYYY-MM-DD", onInvalid = null }: { format?: string; onInvalid?: string | null } = {}
): string | null {
	if (typeof value !== "string") return onInvalid;
	const trimmed = value.trim();
	if (!trimmed) return onInvalid;
	if (isIsoDateString(trimmed) && format === "YYYY-MM-DD") return trimmed;
	const parsed = moment(trimmed, FRONTMATTER_DATE_FORMATS, true);
	return parsed.isValid() ? parsed.format(format) : onInvalid;
}

export function normalizeScheduledDateValue(value: unknown): string | null {
	return normalizeFrontmatterDate(value);
}

function toDateArray(value: unknown): string[] {
	const values = Array.isArray(value) ? value : [value];
	const normalized = new Set<string>();
	for (const entry of values) {
		const date = normalizeScheduledDateValue(entry);
		if (date) {
			normalized.add(date);
		}
	}
	return Array.from(normalized);
}

export function readScheduledDateList(
	frontmatter: Record<string, unknown>
): string[] {
	const values = new Set<string>();
	const sources = [
		frontmatter.scheduledDates,
		frontmatter.scheduled,
		frontmatter.date,
	];
	for (const source of sources) {
		for (const value of toDateArray(source)) {
			values.add(value);
		}
	}
	return [...Array.from(values)].sort();
}

export function writeScheduledDateList(
	frontmatter: Record<string, unknown>,
	dates: string[]
): void {
	const normalized = [...new Set(
		dates
			.map((entry) => normalizeScheduledDateValue(entry))
			.filter((entry): entry is string => Boolean(entry))
	)].sort();
	delete frontmatter.date;
	if (normalized.length === 0) {
		delete frontmatter.scheduled;
		delete frontmatter.scheduledDates;
		return;
	}
	frontmatter.scheduled = normalized[0];
	if (normalized.length === 1) {
		delete frontmatter.scheduledDates;
		return;
	}
	frontmatter.scheduledDates = normalized;
}
