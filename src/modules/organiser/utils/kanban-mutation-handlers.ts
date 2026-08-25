import { Notice } from "@/platform";
import { getDropFailureRecovery } from "./drop-failure-recovery";

type RemoveRecipe = (
	filePath: string,
	options: { sourceColumnId?: string; entryId?: string }
) => void | Promise<void>;

export function createKanbanRemoveHandler(onRemove: RemoveRecipe, logPrefix: string) {
	return async (filePath: string, options: { sourceColumnId?: string; entryId?: string }) => {
		try {
			await onRemove(filePath, options);
		} catch (error) {
			console.error(`[${logPrefix}] Failed to remove recipe`, error);
			new Notice("Could not remove recipe. Please try again.");
		}
	};
}

export function createKanbanDropFailureHandler(
	sourceColumnId: string | undefined,
	targetColumnId: string,
	refreshColumns: (columnIds: string[]) => void,
	logPrefix: string
) {
	return (error: unknown) => {
		const recovery = getDropFailureRecovery(sourceColumnId, targetColumnId);
		refreshColumns(Array.from(recovery.refreshColumns));
		new Notice("Could not move card. It was restored to its previous column.");
		console.error(`[${logPrefix}] Failed to update`, error);
	};
}
