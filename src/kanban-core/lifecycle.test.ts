import { describe, expect, it, vi } from "vitest";
import { classTokens, createKanbanLifecycle } from "./lifecycle";
import { settleExternalDrop } from "./settle-drop";

// No jsdom/happy-dom in this suite's "node" test environment (see
// vitest.config.ts and patcher.test.ts's fake DOM), so onAction delegation
// is exercised against a minimal fake node implementing exactly what
// lifecycle.ts's click handler calls: classList.contains, getAttribute, and
// a parent-chain `closest()`.
class FakeNode {
  dataset: Record<string, string> = {};
  private className: string;
  private attrs = new Map<string, string>();
  private parent: FakeNode | null;
  readonly classList = { contains: (name: string) => this.className.split(" ").includes(name) };

  constructor(options: { className?: string; attributes?: Record<string, string>; parent?: FakeNode } = {}) {
    this.className = options.className ?? "";
    this.parent = options.parent ?? null;
    for (const [name, value] of Object.entries(options.attributes ?? {})) this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  closest(selector: string): FakeNode | null {
    let node: FakeNode | null = this;
    while (node) {
      if (matchesFakeSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  contains(other: FakeNode): boolean {
    let node: FakeNode | null = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
}

function matchesFakeSelector(node: FakeNode, selector: string): boolean {
  if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
  const attrMatch = /^\[([\w-]+)\]$/.exec(selector);
  if (attrMatch) return node.getAttribute(attrMatch[1]) !== null;
  return false;
}

function renderForClickTests(callbacks: Parameters<ReturnType<typeof createKanbanLifecycle>["render"]>[2]) {
  const fakeKanban = vi.fn(function () {
    return { destroy: vi.fn() };
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const element = {
    replaceChildren: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
  const lifecycle = createKanbanLifecycle(fakeKanban as never);
  lifecycle.render(element, [], callbacks, { gutter: "0px" });
  return listeners.get("click") as (event: { target: FakeNode }) => void;
}

function renderCapturingOptions(
  presentation: Parameters<ReturnType<typeof createKanbanLifecycle>["render"]>[3],
  callbacks: Parameters<ReturnType<typeof createKanbanLifecycle>["render"]>[2] = {},
) {
  let capturedOptions: Record<string, unknown> | undefined;
  const fakeKanban = vi.fn(function (this: unknown, options: Record<string, unknown>) {
    capturedOptions = options;
    return { destroy: vi.fn() };
  });
  const element = {
    replaceChildren: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
  } as unknown as HTMLElement;
  const lifecycle = createKanbanLifecycle(fakeKanban as never);
  lifecycle.render(element, [], callbacks, presentation);
  return capturedOptions!;
}

describe("kanban lifecycle boundary", () => {
  it("normalises class input to unique DOM tokens", () => {
    expect(classTokens(["", " card-one  card-two ", "card-one"])).toEqual(["card-one", "card-two"]);
  });

  it("owns one listener and destroys each replaced instance once", () => {
    const destroy = vi.fn();
    const fakeKanban = vi.fn(function () { return { destroy }; });
    const listeners = new Map<string, EventListener>();
    const element = {
      replaceChildren: vi.fn(),
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    } as unknown as HTMLElement;
    const lifecycle = createKanbanLifecycle(fakeKanban as never);
    const presentation = { gutter: "0px", widthBoard: "100%" };
    lifecycle.render(element, [], {}, presentation);
    lifecycle.render(element, [], {}, presentation);
    lifecycle.destroy();
    expect(fakeKanban).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(element.removeEventListener).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
  });

  it("reconciles a same-column external drop without a signed move", async () => {
    const onMove = vi.fn();
    const rebuild = vi.fn();
    await settleExternalDrop({ cardId: "recipe/a", sourceLaneId: "2026-07-13", targetLaneId: "2026-07-13", sourceOrder: [], targetOrder: [] }, { onMove }, rebuild);
    expect(onMove).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledOnce();
  });

  it("forwards a cross-column external drop to the signed move", async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    await settleExternalDrop({ cardId: "recipe/a", sourceLaneId: "2026-07-13", targetLaneId: "2026-07-14", sourceOrder: [], targetOrder: [] }, { onMove }, vi.fn());
    expect(onMove).toHaveBeenCalledOnce();
  });

  it("restores external boards after a signed move error", async () => {
    const error = new Error("stale schedule");
    const onMoveError = vi.fn().mockResolvedValue(undefined);
    const rebuild = vi.fn();
    await settleExternalDrop({ cardId: "recipe/a", sourceLaneId: "2026-07-13", targetLaneId: "2026-07-14", sourceOrder: [], targetOrder: [] }, { onMove: vi.fn().mockRejectedValue(error), onMoveError }, rebuild);
    expect(onMoveError).toHaveBeenCalledWith(error, expect.anything());
    expect(rebuild).toHaveBeenCalledOnce();
  });

  it("delegates a data-kanban-action click to onAction instead of onCardClick", () => {
    const onAction = vi.fn();
    const onCardClick = vi.fn();
    const click = renderForClickTests({ onAction, onCardClick });

    const card = new FakeNode({ className: "kanban-item" });
    card.dataset.eid = "card-1";
    const button = new FakeNode({ attributes: { "data-kanban-action": "remove-recipe" }, parent: card });

    click({ target: button });

    expect(onAction).toHaveBeenCalledWith("remove-recipe", "card-1", expect.anything());
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("falls back to onCardClick when there is no data-kanban-action ancestor", () => {
    const onAction = vi.fn();
    const onCardClick = vi.fn();
    const click = renderForClickTests({ onAction, onCardClick });

    const card = new FakeNode({ className: "kanban-item" });
    card.dataset.eid = "card-1";
    const title = new FakeNode({ className: "card-title", parent: card });

    click({ target: title });

    expect(onCardClick).toHaveBeenCalledWith(expect.anything(), "card-1");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("ignores an action element outside of any card", () => {
    const onAction = vi.fn();
    const onCardClick = vi.fn();
    const click = renderForClickTests({ onAction, onCardClick });

    const button = new FakeNode({ attributes: { "data-kanban-action": "remove-recipe" } });

    click({ target: button });

    expect(onAction).not.toHaveBeenCalled();
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("never builds constructor options containing a key with value undefined", () => {
    const options = renderCapturingOptions({ gutter: "0px" });

    for (const [key, value] of Object.entries(options)) {
      expect(value, `options.${key} should not be undefined`).not.toBeUndefined();
    }
  });

  it("passes only the renderer options owned by the lean client", () => {
    const options = renderCapturingOptions({ gutter: "0px", widthBoard: "100%" });

    expect(options).toMatchObject({ gutter: "0px", widthBoard: "100%" });
    expect(Object.keys(options).sort()).toEqual([
      "boards",
      "copyItem",
      "dragEl",
      "dragendEl",
      "dropEl",
      "element",
      "gutter",
      "widthBoard",
    ]);
  });

  it("reports synchronous and asynchronous onDrop failures without throwing from dropEl", async () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const synchronousError = new Error("sync failure");
    const asynchronousError = new Error("async failure");
    const onDropError = vi.fn();
    const onDrop = vi.fn()
      .mockImplementationOnce(() => {
        throw synchronousError;
      })
      .mockRejectedValueOnce(asynchronousError);
    const options = renderCapturingOptions({ gutter: "0px" }, { onDrop, onDropError });
    const dropEl = options.dropEl as (card: HTMLElement, target: HTMLElement, source: HTMLElement) => void;
    const card = { dataset: { eid: "card-1" } } as unknown as HTMLElement;
    const sourceBoard = { getAttribute: () => "backlog" };
    const targetBoard = { getAttribute: () => "done" };
    const source = { closest: () => sourceBoard } as unknown as HTMLElement;
    const target = { closest: () => targetBoard } as unknown as HTMLElement;

    expect(() => dropEl(card, target, source)).not.toThrow();
    expect(onDropError).toHaveBeenCalledWith(
      synchronousError,
      expect.objectContaining({ cardId: "card-1", sourceLaneId: "backlog", targetLaneId: "done" }),
    );

    expect(() => dropEl(card, target, source)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDropError).toHaveBeenCalledWith(
      asynchronousError,
      expect.objectContaining({ cardId: "card-1", sourceLaneId: "backlog", targetLaneId: "done" }),
    );
    expect(onDropError).toHaveBeenCalledTimes(2);

    const reportingError = new Error("reporting failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reportingOptions = renderCapturingOptions(
      { gutter: "0px" },
      {
        onDrop: () => {
          throw synchronousError;
        },
        onDropError: () => {
          throw reportingError;
        },
      },
    );
    const reportingDropEl = reportingOptions.dropEl as (
      card: HTMLElement,
      target: HTMLElement,
      source: HTMLElement,
    ) => void;
    expect(() => reportingDropEl(card, target, source)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith("Kanban onDropError failed", reportingError);
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("destroys and clears a rendered client when initial reconciliation fails", async () => {
    const destroys: Array<ReturnType<typeof vi.fn>> = [];
    const fakeKanban = vi.fn(function () {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    });
    vi.resetModules();
    vi.doMock("../vendor/jkanban-patched", () => ({ default: fakeKanban }));
    const { createKanbanClient } = await import("../kanban-component/client");

    const snapshotError = new Error("snapshot failed");
    const snapshotListeners = new Map<string, EventListener>();
    const snapshotElement = {
      replaceChildren: vi.fn(),
      addEventListener: vi.fn((type: string, listener: EventListener) => snapshotListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => snapshotListeners.delete(type)),
      querySelectorAll: vi.fn(() => {
        throw snapshotError;
      }),
    } as unknown as HTMLElement;
    expect(() => createKanbanClient({ element: snapshotElement, boards: [] })).toThrow(snapshotError);
    expect(destroys[0]).toHaveBeenCalledOnce();
    expect(snapshotElement.replaceChildren).toHaveBeenCalledTimes(2);
    expect(snapshotListeners.size).toBe(0);

    const callbackError = new Error("initial callback failed");
    const callbackListeners = new Map<string, EventListener>();
    const callbackElement = {
      replaceChildren: vi.fn(),
      addEventListener: vi.fn((type: string, listener: EventListener) => callbackListeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => callbackListeners.delete(type)),
      querySelectorAll: vi.fn(() => []),
    } as unknown as HTMLElement;
    expect(() => createKanbanClient({
      element: callbackElement,
      boards: [],
      onLanesRendered: () => {
        throw callbackError;
      },
    })).toThrow(callbackError);
    expect(destroys[1]).toHaveBeenCalledOnce();
    expect(callbackElement.replaceChildren).toHaveBeenCalledTimes(2);
    expect(callbackListeners.size).toBe(0);

    vi.doUnmock("../vendor/jkanban-patched");
  });

  it("rejects invalid identities before replacing a rendered board", () => {
    const destroy = vi.fn();
    const fakeKanban = vi.fn(function () { return { destroy }; });
    const element = {
      replaceChildren: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
    const lifecycle = createKanbanLifecycle(fakeKanban as never);
    const presentation = { gutter: "0px" };
    lifecycle.render(element, [
      { id: "backlog", titleHtml: "Backlog", cards: [] },
    ], {}, presentation);

    expect(() => lifecycle.render(element, [
      { id: "duplicate", titleHtml: "One", cards: [] },
      { id: "duplicate", titleHtml: "Two", cards: [] },
    ], {}, presentation)).toThrow('Kanban boards contain duplicate lane id "duplicate"');
    expect(() => lifecycle.render(element, [
      { id: "backlog", titleHtml: "Backlog", cards: [{ id: "", html: "Broken" }] },
    ], {}, presentation)).toThrow("Kanban card id cannot be empty");
    expect(() => lifecycle.render(element, [
      { id: "backlog", titleHtml: "Backlog", cards: [{ id: "same", html: "One" }] },
      { id: "done", titleHtml: "Done", cards: [{ id: "same", html: "Two" }] },
    ], {}, presentation)).toThrow('Kanban boards contain duplicate card id "same"');

    expect(fakeKanban).toHaveBeenCalledTimes(1);
    expect(element.replaceChildren).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });
});
