import type { KanbanConstructorOptions } from "../kanban-core/lifecycle";
import type dragula from "dragula";

export type JKanbanInstance = {
	findBoard: (boardId: string) => HTMLElement | null;
	destroy: () => void;
	drake: dragula.Drake | null;
};

export type JKanbanConstructor = new (
	options: KanbanConstructorOptions
) => JKanbanInstance;

declare const jKanbanPatched: JKanbanConstructor;
export default jKanbanPatched;
