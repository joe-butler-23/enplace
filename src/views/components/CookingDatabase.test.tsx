import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import settingsDefaults from "../../settings.defaults.json";
import { ImageResourceStore } from "../utils/image-resources";
import { CookingDatabase } from "./CookingDatabase";

describe("recipe database source errors", () => {
  it("renders one contextual source error instead of an empty collection", () => {
    const markup = renderToStaticMarkup(
      <CookingDatabase
        recipes={[]}
        totalCount={0}
        markedCount={0}
        availableTags={[]}
        settings={settingsDefaults}
        state={{
          search: "",
          sort: "added-desc",
          marked: "all",
          scheduled: "all",
          added: "all",
          tags: [],
        }}
        sourceError="Configured recipe source 'cooking/recipes' does not exist under the current vault root."
        onStateChange={vi.fn()}
        onOpenRecipe={vi.fn()}
        onToggleMarked={vi.fn()}
        onClearMarked={vi.fn()}
        onOpenPlanner={vi.fn()}
        resolveCover={() => null}
        getCoverState={() => ({ status: "none" })}
        coverStore={new ImageResourceStore()}
      />
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      "Configured recipe source &#x27;cooking/recipes&#x27; does not exist under the current vault root."
    );
    expect(markup).not.toContain("No recipes yet");
  });
});

describe("recipe database empty collection", () => {
  it("renders guided first-recipe onboarding instead of a bare empty message", () => {
    const markup = renderToStaticMarkup(
      <CookingDatabase
        recipes={[]}
        totalCount={0}
        markedCount={0}
        availableTags={[]}
        settings={settingsDefaults}
        state={{
          search: "",
          sort: "added-desc",
          marked: "all",
          scheduled: "all",
          added: "all",
          tags: [],
        }}
        onStateChange={vi.fn()}
        onOpenRecipe={vi.fn()}
        onToggleMarked={vi.fn()}
        onClearMarked={vi.fn()}
        onOpenPlanner={vi.fn()}
        resolveCover={() => null}
        getCoverState={() => ({ status: "none" })}
        coverStore={new ImageResourceStore()}
      />
    );

    expect(markup).toContain("No recipes yet");
    expect(markup).toContain("type: recipe");
    expect(markup).toContain("recipe-extraction");
    expect(markup).toContain("mep recipe import");
    expect(markup).toContain("docs/mep-cli-contracts.md");
  });
});
