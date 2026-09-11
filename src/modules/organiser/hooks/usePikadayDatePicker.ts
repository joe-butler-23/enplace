import * as React from "react";
import { useEffectEvent } from "@/shared/use-effect-event";
import Pikaday from "pikaday";

interface UsePikadayDatePickerOptions {
	isOpen: boolean;
	inputRef: React.RefObject<HTMLInputElement | null>;
	containerRef: React.RefObject<HTMLElement | null>;
	selectedDate?: Date;
	onSelect: (date: Date) => void;
	onClose: () => void;
}

/**
 * Shows Pikaday inside the given container while open. Weeks start on Monday, like the board. A
 * layout effect, so the calendar paints in the same frame as its popover rather than one later.
 */
export function usePikadayDatePicker(options: UsePikadayDatePickerOptions): void {
	const { isOpen, inputRef, containerRef, selectedDate, onSelect, onClose } = options;

	const handleSelect = useEffectEvent(onSelect);
	const handleClose = useEffectEvent(onClose);
	const selectedDateKey = selectedDate?.getTime() ?? null;

	React.useLayoutEffect(() => {
		if (!isOpen) return;
		const input = inputRef.current;
		const container = containerRef.current;
		if (!input || !container) return;

		const picker = new Pikaday({
			field: input,
			container,
			bound: false,
			firstDay: 1,
			format: "YYYY-MM-DD",
			onSelect: handleSelect,
			onClose: handleClose,
		});

		if (selectedDateKey !== null) {
			picker.setDate(new Date(selectedDateKey), true);
		}

		picker.show();
		return () => picker.destroy();
	}, [inputRef, containerRef, isOpen, selectedDateKey]);
}
