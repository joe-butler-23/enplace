export type PlannerNavigationIntent = {
  generation: number;
  history: "push" | "replace" | "none";
};

export type PlannerNavigationIntentState = {
  nextGeneration: number;
  pending: PlannerNavigationIntent | null;
  boardReadyGeneration: number | null;
  failure: string | null;
};

export function createPlannerNavigationIntentState(): PlannerNavigationIntentState {
  return { nextGeneration: 0, pending: null, boardReadyGeneration: null, failure: null };
}

export function requestPlannerNavigation(
  state: PlannerNavigationIntentState,
  history: PlannerNavigationIntent["history"]
): PlannerNavigationIntent {
  const intent = { generation: state.nextGeneration + 1, history };
  state.nextGeneration = intent.generation;
  state.pending = intent;
  state.boardReadyGeneration = null;
  state.failure = null;
  return intent;
}

export function cancelPlannerNavigation(
  state: PlannerNavigationIntentState
): void {
  state.pending = null;
  state.boardReadyGeneration = null;
  state.failure = null;
}

export function failPlannerNavigation(
  state: PlannerNavigationIntentState,
  message: string
): void {
  if (state.pending === null) return;
  state.boardReadyGeneration = null;
  state.failure = message;
}

export function retryPlannerNavigation(
  state: PlannerNavigationIntentState
): void {
  if (state.pending === null) return;
  state.boardReadyGeneration = null;
  state.failure = null;
}

export function acknowledgePlannerBoardReady(
  state: PlannerNavigationIntentState
): void {
  state.boardReadyGeneration = state.pending?.generation ?? null;
}

export function settlePlannerNavigation(
  state: PlannerNavigationIntentState,
  datasetReady: boolean
): PlannerNavigationIntent | null {
  if (
    !datasetReady
    || state.pending === null
    || state.failure !== null
    || state.boardReadyGeneration !== state.pending.generation
  ) {
    return null;
  }
  const intent = state.pending;
  state.pending = null;
  state.boardReadyGeneration = null;
  state.failure = null;
  return intent;
}
