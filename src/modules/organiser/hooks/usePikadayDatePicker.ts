import * as React from "react";
import { useEffectEvent } from "@/shared/use-effect-event";
import Pikaday from "pikaday";

interface UsePikadayDatePickerOptions {
	isOpen: boolean;
	containerRef: React.RefObject<HTMLElement | null>;
	selectedDate: Date;
	onSelect: (date: Date) => void;
	onClose: () => void;
}

/**
 * Shows Pikaday inside the given container while open. Weeks start on Monday, like the board.
 * With no input field Pikaday attaches nowhere, so the calendar element is placed here. A layout
 * effect, so the calendar paints in the same frame as its popover rather than one later.
 */
export function usePikadayDatePicker(options: UsePikadayDatePickerOptions): void {
	const { isOpen, containerRef, selectedDate, onSelect, onClose } = options;
	const handleSelect = useEffectEvent(onSelect);
	const handleClose = useEffectEvent(onClose);
	const selectedDateKey = selectedDate.getTime();

	React.useLayoutEffect(() => {
		const container = containerRef.current;
		if (!isOpen || !container) return;
		const picker = new Pikaday({ bound: false, firstDay: 1, onSelect: handleSelect, onClose: handleClose });
		picker.setDate(new Date(selectedDateKey), true);
		container.append(picker.el);
		picker.show();
		return () => picker.destroy();
	}, [containerRef, isOpen, selectedDateKey]);
}
