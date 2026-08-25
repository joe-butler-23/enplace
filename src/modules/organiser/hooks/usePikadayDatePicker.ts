import * as React from "react";
import Pikaday from "pikaday";

interface UsePikadayDatePickerOptions {
	isOpen: boolean;
	inputRef: React.RefObject<HTMLInputElement | null>;
	containerRef: React.RefObject<HTMLElement | null>;
	selectedDate?: Date;
	format?: string;
	onSelect: (date: Date) => void;
	onClose: () => void;
}

interface UsePikadayDatePickerResult {
	gotoToday: () => void;
	clear: () => void;
}

export function usePikadayDatePicker(
	options: UsePikadayDatePickerOptions
): UsePikadayDatePickerResult {
	const {
		isOpen,
		inputRef,
		containerRef,
		selectedDate,
		format = "YYYY-MM-DD",
		onSelect,
		onClose,
	} = options;

	const pickerRef = React.useRef<Pikaday | null>(null);
	const handleSelect = React.useEffectEvent(onSelect);
	const handleClose = React.useEffectEvent(onClose);
	const selectedDateKey = selectedDate?.getTime() ?? null;

	React.useEffect(() => {
		if (!isOpen) {
			if (pickerRef.current) {
				pickerRef.current.destroy();
				pickerRef.current = null;
			}
			return;
		}

		const input = inputRef.current;
		const container = containerRef.current;
		if (!input || !container) return;

		const picker = new Pikaday({
			field: input,
			container,
			bound: false,
			format,
			onSelect: handleSelect,
			onClose: handleClose,
		});

		if (selectedDateKey !== null) {
			picker.setDate(new Date(selectedDateKey), true);
		}

		picker.show();
		pickerRef.current = picker;

		// Remove tooltips from day abbreviations
		container.querySelectorAll(".pika-table abbr[title]").forEach((abbr) => {
			abbr.removeAttribute("title");
		});

		return () => {
			picker.destroy();
			pickerRef.current = null;
		};
	}, [format, inputRef, containerRef, isOpen, selectedDateKey]);

	const gotoToday = React.useCallback(() => {
		pickerRef.current?.gotoToday();
		pickerRef.current?.setDate(new Date(), true);
	}, []);

	const clear = React.useCallback(() => {
		pickerRef.current?.clear();
	}, []);

	return { gotoToday, clear };
}
