export function recipeViewTransitionName(path: string): string {
  return `recipe-${path.replace(/[^a-z0-9_-]/gi, "-")}`;
}

export function startRecipeViewTransition(update: () => void, target: Document = document): ViewTransition | undefined {
  if (target.startViewTransition) return target.startViewTransition(update);
  update();
  return undefined;
}
