declare module "pikaday" {
	interface PikadayOptions {
		field?: HTMLInputElement;
		container?: HTMLElement;
		bound?: boolean;
		format?: string;
		onSelect?: (date: Date) => void;
		onClose?: () => void;
	}

	class Pikaday {
		constructor(options: PikadayOptions);
		setDate(date: Date, preventOnSelect?: boolean): void;
		show(): void;
		hide(): void;
		destroy(): void;
		gotoToday(): void;
		clear(): void;
	}

	export default Pikaday;
}
