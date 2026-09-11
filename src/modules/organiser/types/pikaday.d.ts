declare module "pikaday" {
	interface PikadayOptions {
		bound?: boolean;
		firstDay?: number;
		onSelect?: (date: Date) => void;
		onClose?: () => void;
	}

	class Pikaday {
		constructor(options: PikadayOptions);
		readonly el: HTMLElement;
		setDate(date: Date, preventOnSelect?: boolean): void;
		show(): void;
		destroy(): void;
	}

	export default Pikaday;
}
