// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeView } from "./RecipeView";

// Count actual Marked parses so the test proves the memo boundary avoids renderer work.
// The mock delegates to Marked unchanged after recording both document and inline parses.
const { markdownRenderSpy } = vi.hoisted(() => ({ markdownRenderSpy: vi.fn() }));
vi.mock("marked", async (importOriginal) => {
  const actual = await importOriginal<typeof import("marked")>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      markdownRenderSpy(args[0]);
      return actual.parse(...args);
    },
    parseInline: (...args: Parameters<typeof actual.parseInline>) => {
      markdownRenderSpy(args[0]);
      return actual.parseInline(...args);
    },
  };
});

function renderInto(root: Root, element: Parameters<Root["render"]>[0]) {
  act(() => {
    root.render(element);
  });
}

describe("RecipeView interactive behaviour (bd mise-en-place-fuy)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    markdownRenderSpy.mockClear();
  });

  it("preserves ticks across an unrelated content update but resets them when the ticked list genuinely changes", () => {
    const baseline = [
      "# Soup",
      "",
      "## Ingredients",
      "- water",
      "- salt",
      "",
      "## Method",
      "1. Boil water.",
      "2. Add salt.",
      "",
      "## Notes",
      "Serve warm."
    ].join("\n");

    renderInto(root, <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={baseline} />);

    const ingredientCheckbox = () =>
      container.querySelectorAll<HTMLInputElement>(".recipe-view__ingredients-panel input[type=checkbox]")[0];
    // A step's toggle is its number button, not a checkbox.
    const stepToggle = () =>
      container.querySelectorAll<HTMLButtonElement>(".recipe-view__method .recipe-view__step-number")[0];

    act(() => {
      ingredientCheckbox().click();
      stepToggle().click();
    });
    expect(ingredientCheckbox().checked).toBe(true);
    expect(stepToggle().getAttribute("aria-pressed")).toBe("true");

    // Autosave-echo shape: only the Notes section changed (a typo fix elsewhere in the file).
    // Ingredients and Method are element-wise identical to the baseline.
    const notesEditedOnly = [
      "# Soup",
      "",
      "## Ingredients",
      "- water",
      "- salt",
      "",
      "## Method",
      "1. Boil water.",
      "2. Add salt.",
      "",
      "## Notes",
      "Serve warm and fresh."
    ].join("\n");
    renderInto(root, <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={notesEditedOnly} />);

    expect(ingredientCheckbox().checked).toBe(true);
    expect(stepToggle().getAttribute("aria-pressed")).toBe("true");

    // Now the ingredient list genuinely changes (a third ingredient is added). Ticks are keyed
    // by index, so stale indices would silently mark the wrong rows — the fix must reset them.
    // Method is untouched, so its ticks must survive this update.
    const ingredientsChanged = [
      "# Soup",
      "",
      "## Ingredients",
      "- water",
      "- salt",
      "- pepper",
      "",
      "## Method",
      "1. Boil water.",
      "2. Add salt.",
      "",
      "## Notes",
      "Serve warm and fresh."
    ].join("\n");
    renderInto(root, <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={ingredientsChanged} />);

    expect(ingredientCheckbox().checked).toBe(false);
    expect(stepToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the plain-text editor immediately and keeps raw Markdown", () => {
    const content = "# Soup\n\n![Soup](images/soup.png)\n";
    renderInto(root, <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={content} onSave={vi.fn()} resolveImage={() => "blob:soup"} />);

    act(() => {
      container.querySelector<HTMLButtonElement>("button.recipe-view__edit-action")!.click();
    });

    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Recipe markdown"]');
    expect(editor).not.toBeNull();
    expect(editor!.value).toContain("![Soup](images/soup.png)");
  });

  it("confirms before deleting a recipe", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", { configurable: true, value: confirm });
    renderInto(root, <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={"# Soup\n"} onDelete={onDelete} />);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button.recipe-view__edit-action:last-child")!.click();
      await Promise.resolve();
    });

    expect(confirm).toHaveBeenCalledWith("Delete Soup?");
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("does not re-invoke the markdown renderer for other steps or the notes body when a single step is toggled", () => {
    const content = [
      "# Soup",
      "",
      "## Method",
      "1. Boil water.",
      "2. Add salt.",
      "3. Serve.",
      "",
      "## Notes",
      "Serve warm."
    ].join("\n");

    renderInto(root, <RecipeView path="recipes/soup.md" title="Soup" mode="full" content={content} />);

    // 3 steps (via StepText/ReadInline) + 1 notes body (via PreparedRecipeDocument/ReadDocument).
    expect(markdownRenderSpy).toHaveBeenCalledTimes(4);
    markdownRenderSpy.mockClear();

    const firstStepToggle = container.querySelectorAll<HTMLButtonElement>(
      ".recipe-view__method .recipe-view__step-number"
    )[0];
    act(() => {
      firstStepToggle.click();
    });
    expect(firstStepToggle.getAttribute("aria-pressed")).toBe("true");

    // The toggle changes React state and re-renders RecipeView, but StepText is memoised on
    // `text` alone (unaffected by checked state) and PreparedRecipeDocument on its own props
    // (also unaffected), so none of the three steps and the notes body should re-run the
    // markdown renderer at all.
    expect(markdownRenderSpy).not.toHaveBeenCalled();
  });
});
