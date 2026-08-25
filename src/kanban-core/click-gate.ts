export type ClickGateOptions = {
	clickBlockMs?: number;
	dragCooldownMs?: number;
};

export type ClickIntent = {
	cardId: string;
	split: boolean;
	at: number;
} | null;

export type ClickGate = {
	dragStarted: () => void;
	dragEnded: () => void;
	isDragging: () => boolean;
	shouldSuppressClick: (now?: number) => boolean;
	dragCooldownRemainingMs: (now?: number) => number;
	captureClickIntent: (intent: { cardId: string; split: boolean }) => void;
	clickIntent: () => ClickIntent;
};

// Owns the drag/click timing state that disambiguates a genuine click from
// the tail end of a drag: whether a drag is in flight, when the last drag
// ended, and the most recently captured mousedown click intent. `clickBlockMs`
// suppresses click handling for a short window after a drag ends (drag
// libraries fire a trailing click on drop); `dragCooldownMs` defers column
// refreshes for a short window after a drag ends so the just-dropped DOM
// isn't yanked out from under the user.
export function createClickGate(options: ClickGateOptions = {}): ClickGate {
	const { clickBlockMs = 500, dragCooldownMs = 300 } = options;
	let dragging = false;
	let dragEndedAt = 0;
	let intent: ClickIntent = null;

	return {
		dragStarted() {
			dragging = true;
		},
		dragEnded() {
			dragging = false;
			dragEndedAt = Date.now();
		},
		isDragging() {
			return dragging;
		},
		shouldSuppressClick(now = Date.now()) {
			return dragging || now - dragEndedAt < clickBlockMs;
		},
		dragCooldownRemainingMs(now = Date.now()) {
			return Math.max(0, dragEndedAt + dragCooldownMs - now);
		},
		captureClickIntent({ cardId, split }) {
			intent = { cardId, split, at: Date.now() };
		},
		clickIntent() {
			return intent;
		},
	};
}
