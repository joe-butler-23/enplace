export type CardClickIntent = {
	cardId: string;
	split: boolean;
	at: number;
} | null;

export type SplitModifierState = {
	isPressed: boolean;
	lastPressedAt: number;
};

type ResolveCardSplitOptions = {
	cardId: string;
	eventSplit: boolean;
	now: number;
	clickIntent: CardClickIntent;
	modifierState: SplitModifierState;
	intentWindowMs?: number;
	modifierGraceMs?: number;
};

export function resolveCardSplitOpen(options: ResolveCardSplitOptions): boolean {
	const {
		cardId,
		eventSplit,
		now,
		clickIntent,
		modifierState,
		intentWindowMs = 1200,
		modifierGraceMs = 250,
	} = options;

	if (eventSplit) return true;
	if (modifierState.isPressed) return true;
	if (now - modifierState.lastPressedAt <= modifierGraceMs) return true;

	if (!clickIntent) return false;
	if (clickIntent.cardId !== cardId) return false;
	if (now - clickIntent.at > intentWindowMs) return false;

	return clickIntent.split;
}
