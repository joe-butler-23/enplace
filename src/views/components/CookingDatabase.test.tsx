import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Plan, Recipe } from "@/core";
import { DEFAULT_STANDALONE_SETTINGS as SETTINGS } from "@/standalone/settings";
import { CookingDatabase } from "./CookingDatabase";
type Props = React.ComponentProps<typeof CookingDatabase>;
const plan: Plan = { marked: [], days: new Map(), notes: new Map() };
const recipe = (overrides: Partial<Recipe> = {}): Recipe => ({ path: "recipes/test.md", title: "Test recipe",
  ingredients: [], cover: null, added: null, tags: [], link: "test", ...overrides });
function render(overrides: Partial<Props> = {}): string { return renderToStaticMarkup(<CookingDatabase {...{
  recipes: [], plan, settings: SETTINGS, onPreferencesChange: vi.fn(), onOpenRecipe: vi.fn(), onToggleMarked: vi.fn(),
  onClearMarked: vi.fn(), resolveCover: () => null, ...overrides } as Props} />); }
describe("recipe database markup", () => {
  it("renders resolved covers and the no-cover fallback", () => {
    const props: Partial<Props> = { recipes: [recipe({ cover: "images/test.png" })], resolveCover: () => "/covers/test.png" };
    const covered = render(props); const none = render({ ...props, resolveCover: () => null });
    expect(covered).toContain('src="/covers/test.png"');
    expect(covered).toContain('decoding="sync"');
    expect(covered).not.toContain("<picture");
    expect(covered).not.toContain("srcset=");
    expect(covered).not.toContain("cooking-db__cover--empty"); expect(none).toContain("cooking-db__cover--empty");
  });
  it("guides an empty cookbook and always exposes Add recipe", () => {
    const empty = render();
    const seeded = render({ recipes: [recipe()] });
    expect(empty).toContain("No recipes yet");
    expect(empty).toContain("Add recipe");
    expect(seeded).toContain("Add recipe");
    expect(seeded).not.toContain("No recipes yet");
  });
  it("distinguishes filtered zero results", () => {
    const markup = render({ recipes: [recipe()], settings: { ...SETTINGS, databaseMarkedFilter: "marked" } });
    expect(markup).toContain("No recipes match these filters"); expect(markup).toContain("Clear filters");
    expect(markup).not.toContain("No recipes yet");
  });
  it("shows a source failure instead of an empty-library action", () => {
    const broken = recipe();
    Object.defineProperty(broken, "tags", { get: () => { throw new Error("catalog failed"); } });
    const markup = render({ recipes: [broken] });
    expect(markup).toContain('class="cooking-db__error"'); expect(markup).toContain("catalog failed");
    expect(markup).not.toContain("No recipes yet");
  });
  it("keeps the card action separate and reset", () => {
    const markup = render({ recipes: [recipe()] }); expect(markup).toMatch(/<article[^>]*class="cooking-db__card"/);
    expect(markup).toContain('class="cooking-db__card-open"'); expect(markup).not.toContain('role="button"');
    const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
    expect(/\.cooking-db__card-open\s*\{([^}]*)\}/.exec(css)?.[1]).toContain("all: unset");
  });
});
