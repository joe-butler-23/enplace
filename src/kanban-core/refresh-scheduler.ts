// Owns the pending-lane-set + timer + drag-cooldown deferral logic that used
// to live inline in useKanbanBoard.ts's refreshColumns: batch same-tick
// refresh requests behind `refreshDelayMs`, and defer the whole flush while a
// drag is active or its cooldown hasn't elapsed yet, so the DOM under a
// just-dropped card isn't yanked out from under the user.
export type RefreshSchedulerClickGate = {
	isDragging: () => boolean;
	dragCooldownRemainingMs: (now?: number) => number;
};

export type RefreshSchedulerOptions = {
	refreshDelayMs: number;
	clickGate: RefreshSchedulerClickGate;
	onFlush: (laneIds: string[]) => void;
};

export type RefreshScheduler = {
	/** Queue lanes for refresh. Omit `laneIds` to re-check/reschedule the
	 * already-pending set without adding anything new (callers translate
	 * "refresh everything" into an explicit id list themselves — the
	 * scheduler is lane-list agnostic). */
	request: (laneIds?: string[]) => void;
	/** Cancel any pending timer and drop queued lane ids. */
	cancel: () => void;
};

export function createRefreshScheduler(options: RefreshSchedulerOptions): RefreshScheduler {
	const { refreshDelayMs, clickGate, onFlush } = options;
	const pending = new Set<string>();
	let timer: number | null = null;

	function clearTimer(): void {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
	}

	function flush(): void {
		timer = null;
		const laneIds = Array.from(pending);
		pending.clear();
		onFlush(laneIds);
	}

	function request(laneIds?: string[]): void {
		if (Array.isArray(laneIds)) {
			for (const id of laneIds) pending.add(id);
		}
		if (pending.size === 0) return;

		const now = Date.now();
		const dragCooldownRemainingMs = clickGate.dragCooldownRemainingMs(now);
		const blockedDelayMs = clickGate.isDragging() ? refreshDelayMs : dragCooldownRemainingMs;

		clearTimer();

		if (blockedDelayMs > 0) {
			timer = window.setTimeout(() => {
				timer = null;
				request();
			}, blockedDelayMs + 1);
			return;
		}

		timer = window.setTimeout(flush, refreshDelayMs);
	}

	function cancel(): void {
		clearTimer();
		pending.clear();
	}

	return { request, cancel };
}
