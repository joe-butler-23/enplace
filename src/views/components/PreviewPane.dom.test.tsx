// @vitest-environment happy-dom
import * as React from "react";
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPane, type PreviewPaneProps } from "./PreviewPane";
import type { RecipeViewHandle } from "./RecipeView";

function renderInto(root: Root, element: Parameters<Root["render"]>[0]) {
  act(() => {
    root.render(element);
  });
}

function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PreviewPane split-pane stability", () => {
  let container: HTMLDivElement;
  let root: Root;
  let recipeRef: React.RefObject<RecipeViewHandle | null>;
  let baseProps: PreviewPaneProps;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    recipeRef = React.createRef<RecipeViewHandle | null>();
    baseProps = {
      path: "recipes/soup.md",
      content: "# Soup\n\n## Ingredients\n- water\n",
      isRecipe: true,
      width: 420,
      recipeRef,
      onClose: vi.fn(),
      onWidth: vi.fn(),
      onSave: vi.fn().mockResolvedValue({ text: "", conflicts: 0 }),
      resolveImage: () => null,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps the same recipe editor mounted (and its unsaved typing intact) when content changes for the same path", () => {
    renderInto(root, <PreviewPane {...baseProps} />);
    act(() => {
      container.querySelector<HTMLButtonElement>("button.recipe-view__action")!.click();
    });
    const editor = () => container.querySelector<HTMLTextAreaElement>("textarea.recipe-view__text-editor");
    expect(editor()).not.toBeNull();
    const editorBeforeUpdate = editor()!;

    typeInto(editorBeforeUpdate, "# Soup\n\n## Ingredients\n- water\n- salt (typing…)\n");
    expect(editorBeforeUpdate.value).toContain("salt (typing…)");

    // An autosave echo or a partner's edit lands with new `content` for the same path.
    renderInto(root, <PreviewPane {...baseProps} content="# Soup\n\n## Ingredients\n- water\n- pepper\n" />);

    // The pane must not have remounted: same DOM node, still editing, typing untouched.
    expect(editor()).toBe(editorBeforeUpdate);
    expect(editor()!.value).toContain("salt (typing…)");
    expect(container.querySelectorAll(".recipe-view__action").length).toBeGreaterThan(0);
    expect([...container.querySelectorAll(".recipe-view__action")].map((node) => node.textContent)).toEqual(["Done"]);
  });

  it("still resets for a genuinely different recipe", () => {
    renderInto(root, <PreviewPane {...baseProps} />);
    act(() => {
      container.querySelector<HTMLButtonElement>("button.recipe-view__action")!.click();
    });
    expect(container.querySelector("textarea.recipe-view__text-editor")).not.toBeNull();

    renderInto(root, <PreviewPane {...baseProps} path="recipes/other.md" content="# Other\n" />);

    // A different path is a different recipe: editing state does not leak across it.
    expect([...container.querySelectorAll(".recipe-view__action")].map((node) => node.textContent)).toEqual(["Edit"]);
  });
});
