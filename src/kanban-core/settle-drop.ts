import type { KanbanMove } from "./lifecycle";

// An optimistic drop can settle as confirmed, rejected, or indeterminate.
export type SettlementResult = "confirmed" | "rejected" | "indeterminate";

// A resolved onMove confirms by default; it may explicitly report an
// indeterminate outcome. Rejection is represented by throwing or rejecting.
export type MoveSettlementOutcome = void | "indeterminate";

export type SettleExternalDropSource = {
  onMove: (move: KanbanMove) => Promise<MoveSettlementOutcome> | MoveSettlementOutcome;
  onMoveError?: (error: unknown, move: KanbanMove) => Promise<void> | void;
  /** Fires once per settled move with the final three-way result, after any
   * rollback (`rejected`) has already happened. Optional and additive: when
   * omitted, behaviour is exactly the pre-existing two-way settle/rollback
   * pipeline. */
  onSettled?: (result: SettlementResult, move: KanbanMove) => void;
};

function reportSettled(source: SettleExternalDropSource, result: SettlementResult, move: KanbanMove): void {
  try {
    source.onSettled?.(result, move);
  } catch {
    // Settlement reporting cannot change the outcome.
  }
}

export async function settleMove(move: KanbanMove, source: SettleExternalDropSource, rollback: () => void): Promise<SettlementResult> {
  let result: SettlementResult;
  try {
    const outcome = await source.onMove(move);
    result = outcome === "indeterminate" ? "indeterminate" : "confirmed";
  } catch (error) {
    try {
      await source.onMoveError?.(error, move);
    } catch {
      // A move failure remains rejected even when its error reporter fails.
    }
    try {
      rollback();
    } catch {
      // Settling still completes when a consumer's rebuild throws.
    }
    result = "rejected";
  }
  reportSettled(source, result, move);
  return result;
}

export async function settleExternalDrop(move: KanbanMove, source: SettleExternalDropSource, rebuild: () => void): Promise<SettlementResult> {
  if (move.sourceLaneId === move.targetLaneId) {
    rebuild();
    reportSettled(source, "confirmed", move);
    return "confirmed";
  }
  return settleMove(move, source, rebuild);
}
