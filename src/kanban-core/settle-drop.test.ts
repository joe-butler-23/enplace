import { describe, expect, it, vi } from "vitest";
import { settleExternalDrop, type SettlementResult } from "./settle-drop";
import type { KanbanMove } from "./lifecycle";

function buildMove(overrides: Partial<KanbanMove> = {}): KanbanMove {
  return {
    cardId: "card-1",
    sourceLaneId: "lane-a",
    targetLaneId: "lane-b",
    sourceOrder: [],
    targetOrder: [],
    ...overrides,
  };
}

describe("settleExternalDrop three-way reconciliation", () => {
  it("settles confirmed when onMove resolves, without rolling back", async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    const rebuild = vi.fn();
    const onSettled = vi.fn();
    await settleExternalDrop(buildMove(), { onMove, onSettled }, rebuild);
    expect(onMove).toHaveBeenCalledOnce();
    expect(rebuild).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith("confirmed", expect.objectContaining({ cardId: "card-1" }));
  });

  it("settles rejected and rolls back when onMove rejects", async () => {
    const error = new Error("stale schedule");
    const onMove = vi.fn().mockRejectedValue(error);
    const onMoveError = vi.fn().mockResolvedValue(undefined);
    const rebuild = vi.fn();
    const onSettled = vi.fn();
    await settleExternalDrop(buildMove(), { onMove, onMoveError, onSettled }, rebuild);
    expect(onMoveError).toHaveBeenCalledWith(error, expect.anything());
    expect(rebuild).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("rejected", expect.objectContaining({ cardId: "card-1" }));
  });

  it("settles indeterminate without rolling back when onMove reports an unverifiable readback", async () => {
    const onMove = vi.fn().mockResolvedValue("indeterminate" as const);
    const rebuild = vi.fn();
    const onSettled = vi.fn();
    await settleExternalDrop(buildMove(), { onMove, onSettled }, rebuild);
    expect(rebuild).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith("indeterminate", expect.objectContaining({ cardId: "card-1" }));
  });

  it("treats a same-lane reorder as confirmed without calling onMove", async () => {
    const onMove = vi.fn();
    const rebuild = vi.fn();
    const onSettled = vi.fn();
    await settleExternalDrop(buildMove({ sourceLaneId: "lane-a", targetLaneId: "lane-a" }), { onMove, onSettled }, rebuild);
    expect(onMove).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith("confirmed", expect.anything());
  });

  it("keeps same-lane confirmation authoritative when onSettled throws", async () => {
    const authoritativeOrder = ["card-2", "card-1"];
    let renderedOrder = ["card-1", "card-2"];
    const onMove = vi.fn();
    const rebuild = vi.fn(() => {
      renderedOrder = [...authoritativeOrder];
    });
    const onSettled = vi.fn(() => {
      throw new Error("presentation failed");
    });

    await expect(settleExternalDrop(buildMove({ sourceLaneId: "lane-a", targetLaneId: "lane-a" }), { onMove, onSettled }, rebuild)).resolves.toBe("confirmed");

    expect(onMove).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(authoritativeOrder).toEqual(["card-2", "card-1"]);
    expect(renderedOrder).toEqual(authoritativeOrder);
  });

  it("returns confirmed without requiring onSettled", async () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    const rebuild = vi.fn();
    await expect(settleExternalDrop(buildMove(), { onMove }, rebuild)).resolves.toBe("confirmed");
    expect(onMove).toHaveBeenCalledOnce();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("never produces onSettled('rejected') without a rebuild having already happened", async () => {
    const error = new Error("boom");
    const onMove = vi.fn().mockRejectedValue(error);
    const calls: string[] = [];
    const rebuild = vi.fn(() => calls.push("rebuild"));
    const onSettled = vi.fn((result: SettlementResult) => calls.push(`settled:${result}`));
    await settleExternalDrop(buildMove(), { onMove, onSettled }, rebuild);
    expect(calls).toEqual(["rebuild", "settled:rejected"]);
  });
});
