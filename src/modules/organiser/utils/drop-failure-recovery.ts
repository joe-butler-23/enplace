export function getDropFailureRecovery(
	sourceColumnId: string | undefined,
	targetColumnId: string
): { refreshColumns: Set<string> } {
	const refreshColumns = new Set<string>();
	if (sourceColumnId) refreshColumns.add(sourceColumnId);
	refreshColumns.add(targetColumnId);
	return { refreshColumns };
}
