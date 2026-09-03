import { describe, expect, it, vi } from "vitest";
import { recipeViewTransitionName, startRecipeViewTransition } from "./recipe-view-transition";

describe("recipe view transition", () => {
  it("uses one stable shared-element identity for the card and hero", () => {
    expect(recipeViewTransitionName("Recipes/Red Pepper & Feta.md")).toBe("recipe-Recipes-Red-Pepper---Feta-md");
  });

  it("commits navigation through the platform transition lifecycle when available", () => {
    const update = vi.fn();
    const transition = {} as ViewTransition;
    const startViewTransition = vi.fn((callback: () => void) => { callback(); return transition; });
    const result = startRecipeViewTransition(update, { startViewTransition } as unknown as Document);
    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(result).toBe(transition);
  });

  it("commits directly when the platform transition is unavailable", () => {
    const update = vi.fn();
    expect(startRecipeViewTransition(update, {} as Document)).toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });
});
