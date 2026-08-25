import jKanbanPatched, { type JKanbanInstance } from "../vendor/jkanban-patched";
import {
	createBoardPatcher,
	buildJKanbanCardElement,
	createKanbanLifecycle,
	createSelectorAccessors,
	JKANBAN_SELECTORS,
	type KanbanBoardData,
	type KanbanPresentation,
	type KanbanLanePatch,
	type LifecycleCallbacks,
} from "../kanban-core";
import "dragula/dist/dragula.css";
import "./structural.css";

export type KanbanClientOptions = {
	element: HTMLElement;
	boards: KanbanBoardData[];
	callbacks?: LifecycleCallbacks;
	presentation?: Partial<KanbanPresentation>;
	onLanesRendered?: (laneIds: string[], elements: Map<string, HTMLElement>) => void;
};

export type KanbanClient = {
	patchLanes: (lanes: KanbanLanePatch[]) => string[];
	invalidateLanes: (laneIds: Iterable<string>) => void;
	rekeyCard: (element: HTMLElement, newId: string) => void;
	lane: (id: string) => HTMLElement | null;
	destroy: () => void;
};

export function createKanbanClient(options: KanbanClientOptions): KanbanClient {
	const { element, callbacks = {}, onLanesRendered } = options;
	const lifecycle = createKanbanLifecycle<JKanbanInstance>(jKanbanPatched);
	const accessors = createSelectorAccessors(JKANBAN_SELECTORS);
	const patcher = createBoardPatcher({
		container: element,
		selectors: JKANBAN_SELECTORS,
		buildCardElement: buildJKanbanCardElement,
		onLanesRendered,
	});
	const presentation: KanbanPresentation = {
		gutter: options.presentation?.gutter ?? "0px",
		...(options.presentation?.widthBoard !== undefined && {
			widthBoard: options.presentation.widthBoard,
		}),
	};

	const lane = (id: string) => accessors.findLane(element, id);
	const lifecycleCallbacks: LifecycleCallbacks = {
		...callbacks,
		onDrop: (move) => {
			patcher.invalidateLanes([move.sourceLaneId, move.targetLaneId]);
			return callbacks.onDrop?.(move);
		},
	};

	try {
		lifecycle.render(element, options.boards, lifecycleCallbacks, presentation);
		patcher.snapshotFromDom();

		if (onLanesRendered) {
			const ids = options.boards.map((board) => board.id);
			const elements = new Map<string, HTMLElement>();
			for (const laneElement of Array.from(element.querySelectorAll<HTMLElement>(JKANBAN_SELECTORS.lane))) {
				const id = accessors.laneId(laneElement);
				if (id) elements.set(id, laneElement);
			}
			onLanesRendered(ids, elements);
		}
	} catch (error) {
		lifecycle.destroy();
		element.replaceChildren();
		throw error;
	}

	return {
		patchLanes: patcher.patchLanes,
		invalidateLanes: patcher.invalidateLanes,
		rekeyCard: patcher.rekeyCard,
		lane,
		destroy: lifecycle.destroy,
	};
}
