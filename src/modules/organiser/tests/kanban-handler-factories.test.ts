import { beforeEach, describe, expect, it, vi } from "vitest";
const { Notice } = vi.hoisted(() => ({ Notice: vi.fn() }));

vi.mock("@/platform", () => ({ Notice }));

import { createKanbanDropFailureHandler, createKanbanRemoveHandler } from "../utils/kanban-mutation-handlers";

describe("kanban production rejection handlers", () => {
	beforeEach(() => Notice.mockClear());

  it("catches rejected removal without an unhandled rejection and emits one Notice", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const remove = vi.fn().mockRejectedValue(new Error("unmark failed"));
    try {
      await createKanbanRemoveHandler(remove, "Board")("recipes/soup.md", { sourceColumnId: "marked", entryId: "id" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(remove).toHaveBeenCalledWith("recipes/soup.md", { sourceColumnId: "marked", entryId: "id" });
      expect(Notice).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith("Could not remove recipe. Please try again.");
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });

  it("reconciles both columns and emits one restoration Notice for a rejected drop", () => {
    const refresh = vi.fn();
    createKanbanDropFailureHandler("2026-07-14", "marked", refresh, "Board")(new Error("write failed"));
    expect(refresh).toHaveBeenCalledWith(["2026-07-14", "marked"]);
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith("Could not move card. It was restored to its previous column.");
  });
});
