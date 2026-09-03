import { getDropFailureRecovery } from "./drop-failure-recovery";

export function createKanbanDropFailureHandler(
	sourceColumnId: string | undefined,
	targetColumnId: string,
	refreshColumns: (columnIds: string[]) => void,
	logPrefix: string,
  notify: (message: string) => void
) {
	return (error: unknown) => {
		const recovery = getDropFailureRecovery(sourceColumnId, targetColumnId);
		refreshColumns(Array.from(recovery.refreshColumns));
		notify("Could not move card. It was restored to its previous column.");
		console.error(`[${logPrefix}] Failed to update`, error);
	};
}

export function createKanbanOrderFailureHandler(
	refreshColumns: () => void,
	logPrefix: string,
  notify: (message: string) => void
) {
	return (error: unknown) => {
		refreshColumns();
		notify("Card moved, but its position in the column could not be saved.");
		console.error(`[${logPrefix}] Failed to save planner order`, error);
	};
}
