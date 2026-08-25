import { KANBAN_ACTION_ATTRIBUTE } from "./selectors";

export type KanbanCardData = {
  id: string;
  html: string;
  classes?: string[];
  elementTimingIdentifier?: string;
};

export type KanbanBoardData = {
  id: string;
  titleHtml: string;
  cards: KanbanCardData[];
  headerClasses?: string[];
  bodyClasses?: string[];
};

export type KanbanMove = {
  cardId: string;
  sourceLaneId: string;
  targetLaneId: string;
  index: number;
  sourceOrder: string[];
  targetOrder: string[];
};

export type KanbanDrop = KanbanMove & { element: HTMLElement; container: HTMLElement };

export type LifecycleCallbacks = {
  copyItem?: (element: HTMLElement) => boolean;
  dragEl?: (element: HTMLElement) => void;
  dragendEl?: (element: HTMLElement) => void;
  onDrop?: (move: KanbanDrop) => void | Promise<void>;
  onDropError?: (error: unknown, move: KanbanDrop) => void;
  onCardMouseDown?: (event: MouseEvent, cardId: string) => void;
  onCardClick?: (event: MouseEvent, cardId: string) => void;
  /** Delegated click on any `[data-kanban-action]` element inside a card;
   * fires instead of `onCardClick` for that click. */
  onAction?: (name: string, cardId: string, event: MouseEvent) => void;
};

export type KanbanPresentation = {
  gutter: string;
  widthBoard?: string;
};

// Minimal structural surface of a jKanban-shaped instance: the subset the
// lifecycle itself touches (destroy on teardown). Consumers construct the
// lifecycle with their own constructor (e.g. MEP's `@/vendor/jkanban-patched`)
// and get that constructor's own (wider) instance type back via TInstance.
export type KanbanConstructorInstance = {
  destroy?: () => void;
};

export type KanbanConstructorOptions = {
  element: HTMLElement;
  gutter: string;
  widthBoard?: string;
  boards: KanbanBoardData[];
  copyItem: ((element: HTMLElement) => boolean) | false;
  dragEl: (element: HTMLElement) => void;
  dragendEl: (element: HTMLElement) => void;
  dropEl: (card: HTMLElement, target: HTMLElement, source: HTMLElement) => void;
};

export type KanbanConstructor<TInstance extends KanbanConstructorInstance> = new (
  options: KanbanConstructorOptions
) => TInstance;

export function classTokens(classes: readonly string[] | undefined): string[] {
  return Array.from(new Set((classes ?? []).flatMap((className) => className.split(/\s+/)).filter(Boolean)));
}

function validateBoards(boards: KanbanBoardData[]): void {
  const laneIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const board of boards) {
    if (!board.id) throw new Error("Kanban lane id cannot be empty");
    if (laneIds.has(board.id)) throw new Error(`Kanban boards contain duplicate lane id "${board.id}"`);
    laneIds.add(board.id);
    for (const card of board.cards) {
      if (!card.id) throw new Error("Kanban card id cannot be empty");
      if (cardIds.has(card.id)) throw new Error(`Kanban boards contain duplicate card id "${card.id}"`);
      cardIds.add(card.id);
    }
  }
}

function columnOrder(container: HTMLElement, columnId: string): string[] {
  const board = container.querySelector(`[data-id="${CSS.escape(columnId)}"]`);
  return board ? Array.from(board.querySelectorAll<HTMLElement>(".kanban-drag > .kanban-item"), (item) => item.dataset.eid).filter((id): id is string => Boolean(id)) : [];
}

function reportDropError(callbacks: LifecycleCallbacks, error: unknown, move: KanbanDrop): void {
  if (!callbacks.onDropError) {
    console.error("Kanban onDrop failed", error);
    return;
  }
  try {
    callbacks.onDropError(error, move);
  } catch (reportingError) {
    console.error("Kanban onDropError failed", reportingError);
  }
}

export function createKanbanLifecycle<TInstance extends KanbanConstructorInstance>(ctor: KanbanConstructor<TInstance>) {
  let instance: TInstance | null = null;
  let detachClick: (() => void) | null = null;
  const destroy = () => {
    detachClick?.();
    detachClick = null;
    instance?.destroy?.();
    instance = null;
  };
  return {
    destroy,
    render(element: HTMLElement, boards: KanbanBoardData[], callbacks: LifecycleCallbacks, presentation: KanbanPresentation): TInstance {
      if (typeof ctor !== "function") throw new Error("jKanban constructor not found");
      validateBoards(boards);
      destroy();
      element.replaceChildren();
      instance = new ctor({
        element,
        gutter: presentation.gutter,
        ...(presentation.widthBoard !== undefined && { widthBoard: presentation.widthBoard }),
        boards,
        copyItem: callbacks.copyItem ?? false,
        dragEl: callbacks.dragEl ?? (() => undefined),
        dragendEl: callbacks.dragendEl ?? (() => undefined),
        dropEl: (card: HTMLElement, target: HTMLElement, source: HTMLElement) => {
          const cardId = card.dataset.eid;
          const targetLaneId = target.closest(".kanban-board")?.getAttribute("data-id");
          const sourceLaneId = source.closest(".kanban-board")?.getAttribute("data-id");
          if (!cardId || !targetLaneId || !sourceLaneId) return;
          const sourceOrder = columnOrder(element, sourceLaneId);
          const targetOrder = columnOrder(element, targetLaneId);
          const move = { cardId, sourceLaneId, targetLaneId, index: targetOrder.indexOf(cardId), sourceOrder, targetOrder, element: card, container: element };
          try {
            void Promise.resolve(callbacks.onDrop?.(move)).catch((error) => {
              reportDropError(callbacks, error, move);
            });
          } catch (error) {
            reportDropError(callbacks, error, move);
          }
        },
      });
      const click = (event: MouseEvent) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>(".kanban-item");
        if (!card?.dataset.eid) return;
        const actionEl = (event.target as HTMLElement).closest<HTMLElement>(`[${KANBAN_ACTION_ATTRIBUTE}]`);
        if (actionEl && card.contains(actionEl)) {
          const actionName = actionEl.getAttribute(KANBAN_ACTION_ATTRIBUTE);
          if (actionName) {
            callbacks.onAction?.(actionName, card.dataset.eid, event);
            return;
          }
        }
        callbacks.onCardClick?.(event, card.dataset.eid);
      };
      const mouseDown = (event: MouseEvent) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>(".kanban-item");
        if (card?.dataset.eid) callbacks.onCardMouseDown?.(event, card.dataset.eid);
      };
      element.addEventListener("click", click);
      element.addEventListener("mousedown", mouseDown);
      detachClick = () => {
        element.removeEventListener("click", click);
        element.removeEventListener("mousedown", mouseDown);
      };
      return instance;
    },
  };
}
