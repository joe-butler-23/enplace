export function resolveFilePathFromItemId(
	itemId: string,
	resolvedFilePath?: string
): string {
	if (resolvedFilePath && resolvedFilePath.length > 0) {
		return resolvedFilePath;
	}
	const separatorIndex = itemId.indexOf("::");
	if (separatorIndex === -1) {
		return itemId;
	}
	return itemId.slice(0, separatorIndex);
}
