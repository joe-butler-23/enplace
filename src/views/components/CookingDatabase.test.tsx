import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CookingDatabase } from "./CookingDatabase";

type DatabaseProps = React.ComponentProps<typeof CookingDatabase>;

function renderDatabase(overrides: Partial<DatabaseProps> = {}): string {
  const props: DatabaseProps = {
    recipes: [],
    totalCount: 0,
    markedCount: 0,
    availableTags: [],
    state: { search: "", sort: "added-desc", marked: "all", scheduled: "all", added: "all", tags: [] },
    onStateChange: vi.fn(),
    onSearchChange: vi.fn(),
    onOpenRecipe: vi.fn(),
    onToggleMarked: vi.fn(),
    onClearMarked: vi.fn(),
    resolveCover: () => null,
    ...overrides
  };
  return renderToStaticMarkup(<CookingDatabase {...props} />);
}

describe("recipe database source errors", () => {
  it("renders one contextual source error instead of an empty collection", () => {
    const markup = renderDatabase({
      sourceError: "Configured recipe source 'cooking/recipes' does not exist under the current vault root."
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      "Configured recipe source &#x27;cooking/recipes&#x27; does not exist under the current vault root."
    );
    expect(markup).not.toContain("No recipes yet");
  });
});

describe("recipe database cover states", () => {
  it("keeps pending covers neutral while preserving the no-image state", () => {
    const recipe = [{ path: "recipes/test.md", title: "Test recipe", marked: false }];
    const props: Partial<DatabaseProps> = {
      recipes: recipe,
      totalCount: 1,
      resolveCover: () => "/covers/test.png",
    };

    const coveredMarkup = renderDatabase(props);
    const noneMarkup = renderDatabase({ ...props, resolveCover: () => null });

    expect(coveredMarkup).toContain('src="/covers/test.png"');
    expect(coveredMarkup).toContain('elementtiming="recipes/test.md"');
    expect(coveredMarkup).not.toContain("cooking-db__cover--empty");
    expect(noneMarkup).toContain("cooking-db__cover--empty");
    expect(noneMarkup).not.toContain('elementtiming="recipes/test.md"');
    expect(noneMarkup).toContain('elementtiming="mep:database-card-title:recipes/test.md"');
  });
});

describe("recipe database empty collection", () => {
  it("renders guided first-recipe onboarding instead of a bare empty message", () => {
    const markup = renderDatabase();

    expect(markup).toContain("No recipes yet");
    expect(markup).toContain("## Ingredients");
    expect(markup).toContain("Import recipe");
    expect(markup).toContain("Import recipe");
  });

  it("distinguishes filtered zero results from a truly empty vault", () => {
    const markup = renderDatabase({
      totalCount: 3,
      state: { search: "soup", sort: "added-desc", marked: "all", scheduled: "all", added: "all", tags: [] }
    });
    expect(markup).toContain("No recipes match these filters");
    expect(markup).toContain("Clear filters");
    expect(markup).not.toContain("No recipes yet");
  });

  it("keeps recipe card actions semantically separate from the mark checkbox", () => {
    const recipe = [{ path: "recipes/test.md", title: "Test recipe", marked: false }];
    const markup = renderDatabase({ recipes: recipe, totalCount: 1 });
    expect(markup).toContain("<article class=\"cooking-db__card\"");
    expect(markup).toContain("class=\"cooking-db__card-open\"");
    expect(markup).not.toContain('role="button"');
  });
});

describe("recipe card styling", () => {
  it("resets the clickable card wrapper so it never falls back to browser button styling", () => {
    const recipe = [{ path: "recipes/test.md", title: "Test recipe", marked: false }];
    const markup = renderDatabase({ recipes: recipe, totalCount: 1 });
    const wrapperClass = /<button[^>]*class="([^"]*)"/.exec(markup.slice(markup.indexOf("cooking-db__card\"")))?.[1];
    expect(wrapperClass).toBe("cooking-db__card-open");

    const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
    const rule = new RegExp(`\\.${wrapperClass}\\s*\\{([^}]*)\\}`).exec(css);
    expect(rule?.[1]).toContain("all: unset");
  });
});
