export type DragIntent = {
	cardId: string;
	sourceLaneId?: string;
	duplicate: boolean;
	isTemplate: boolean;
};

export type ResolveDragIntentAtStartInput = {
	cardId: string;
	sourceLaneId?: string;
	isTemplate: boolean;
};

export type DragIntentTrackerOptions = {
	isDuplicateModifierPressed: () => boolean;
};

export type DragIntentTracker = {
	resolveAtStart: (input: ResolveDragIntentAtStartInput) => DragIntent;
	active: () => DragIntent | null;
	clear: () => void;
};

// Owns the DragIntent lifecycle for a single active drag: which card is
// being dragged, where it came from, and whether the drop should duplicate
// (copy) rather than move. Callers resolve DOM-derived inputs (card id,
// source lane id, template-ness) themselves; this tracker only combines
// those with the duplicate-modifier state and memoizes the result while the
// same card stays active, so repeated resolution calls during one drag
// (e.g. from both a copy-decision hook and a drag-start hook) agree on a
// single intent.
export function createDragIntentTracker(options: DragIntentTrackerOptions): DragIntentTracker {
	const { isDuplicateModifierPressed } = options;
	let activeIntent: DragIntent | null = null;

	return {
		resolveAtStart(input) {
			if (activeIntent && activeIntent.cardId === input.cardId) {
				return activeIntent;
			}
			const duplicate = input.isTemplate || isDuplicateModifierPressed();
			const intent: DragIntent = {
				cardId: input.cardId,
				sourceLaneId: input.sourceLaneId,
				duplicate,
				isTemplate: input.isTemplate,
			};
			activeIntent = intent;
			return intent;
		},
		active() {
			return activeIntent;
		},
		clear() {
			activeIntent = null;
		},
	};
}
