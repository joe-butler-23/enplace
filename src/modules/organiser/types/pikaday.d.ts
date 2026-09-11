declare module "pikaday" {
	interface PikadayOptions {
		field?: HTMLInputElement;
		container?: HTMLElement;
		bound?: boolean;
		firstDay?: number;
		format?: string;
		onSelect?: (date: Date) => void;
		onClose?: () => void;
	}

	class Pikaday {
		constructor(options: PikadayOptions);
		setDate(date: Date, preventOnSelect?: boolean): void;
		show(): void;
		destroy(): void;
	}

	export default Pikaday;
}
