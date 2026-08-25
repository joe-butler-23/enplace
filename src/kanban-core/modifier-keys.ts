export type ModifierKeyHandlers = {
	attach: () => void;
	detach: () => void;
};

export function createModifierKeyHandlers(
	update: (pressed: boolean) => void,
	keys: string[]
): ModifierKeyHandlers {
	const handleKeyDown = (event: KeyboardEvent) => {
		if (!keys.includes(event.key)) return;
		update(true);
	};
	const handleKeyUp = (event: KeyboardEvent) => {
		if (!keys.includes(event.key)) return;
		update(false);
	};
	const handleWindowBlur = () => update(false);

	return {
		attach: () => {
			window.addEventListener("keydown", handleKeyDown, true);
			window.addEventListener("keyup", handleKeyUp, true);
			window.addEventListener("blur", handleWindowBlur);
		},
		detach: () => {
			window.removeEventListener("keydown", handleKeyDown, true);
			window.removeEventListener("keyup", handleKeyUp, true);
			window.removeEventListener("blur", handleWindowBlur);
		},
	};
}
