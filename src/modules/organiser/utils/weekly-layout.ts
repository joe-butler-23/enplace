export const MIN_WEEKLY_COLUMN_WIDTH_PX = 200;
export const WEEKLY_TRACK_COUNT = 5; // Marked + 4 day lanes per row
export const WEEKLY_TRACK_GAP_PX = 12;

export function normalizeWeeklyColumnMinWidth(width: number): number {
	if (!Number.isFinite(width)) return MIN_WEEKLY_COLUMN_WIDTH_PX;
	return Math.max(MIN_WEEKLY_COLUMN_WIDTH_PX, Math.round(width));
}

export function computeWeeklyTrackWidth(
	hostWidth: number,
	columnMinWidth: number
): number {
	const minWidth = normalizeWeeklyColumnMinWidth(columnMinWidth);
	if (!Number.isFinite(hostWidth) || hostWidth <= 0) return minWidth;

	const totalGapWidth = WEEKLY_TRACK_GAP_PX * (WEEKLY_TRACK_COUNT - 1);
	const expandedTrackWidth = Math.max(0, hostWidth - totalGapWidth) / WEEKLY_TRACK_COUNT;
	return Math.max(minWidth, expandedTrackWidth);
}
