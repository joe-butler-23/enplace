export type PlannerRefreshPriorityState = {
  prioritized: boolean;
  pendingStart: (() => void) | null;
  generation: number;
};

export function createPlannerRefreshPriorityState(
  prioritized = false
): PlannerRefreshPriorityState {
  return { prioritized, pendingStart: null, generation: 0 };
}

export function prioritizePlannerRefresh(state: PlannerRefreshPriorityState): void {
  state.prioritized = true;
  state.pendingStart?.();
}

export function registerPlannerRefreshStart(
  state: PlannerRefreshPriorityState,
  start: () => void
): () => void {
  let started = false;
  const generation = state.generation;
  const startOnce = () => {
    if (started || state.generation !== generation) return;
    started = true;
    if (state.pendingStart === startOnce) state.pendingStart = null;
    start();
  };
  state.pendingStart = startOnce;
  if (state.prioritized) startOnce();
  return startOnce;
}

export function resetPlannerRefreshPriority(
  state: PlannerRefreshPriorityState,
  prioritized = false
): void {
  state.prioritized = prioritized;
  state.pendingStart = null;
  state.generation += 1;
}
