// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan, Recipe } from "@/core";
import { DEFAULT_STANDALONE_SETTINGS as SETTINGS } from "@/standalone/settings";
import { CookingDatabase } from "./CookingDatabase";
const recent = new Date().toISOString();
const recipe = (path: string, title: string, overrides: Partial<Recipe> = {}): Recipe => ({
  path, title, link: title, ingredients: [], cover: null, added: recent, tags: ["quick"], ...overrides });
const baseRecipes = [recipe("recipes/soup.md", "Soup", { cover: "images/soup.jpg" }),
  recipe("recipes/salad.md", "Salad"), recipe("recipes/stew.md", "Stew", { added: "2000-01-01", tags: ["slow"] })];
const plan = (marked: string[] = ["Soup"], days = new Map<string, string[]>()) => ({ marked, days, notes: new Map() });
const callbacks = { onPreferencesChange: vi.fn(), onOpenRecipe: vi.fn(), onToggleMarked: vi.fn(), onClearMarked: vi.fn(),
  resolveCover: (path: string | null) => path ? `blob:${path}` : null };
const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
describe("CookingDatabase owner wiring", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    Object.values(callbacks).forEach((callback) => "mockClear" in callback && callback.mockClear()); });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  const render = (recipes: readonly Recipe[] = baseRecipes, nextPlan: Plan = plan()): void => { act(() => root.render(
    <CookingDatabase recipes={recipes} plan={nextPlan} settings={SETTINGS} {...callbacks} />)); };
  const paths = () => [...container.querySelectorAll<HTMLElement>("article")].map(({ dataset }) => dataset.path);
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button,[role="option"]')]
    .find((node) => node.textContent === text) ?? (() => { throw new Error(`Missing ${text}`); })();
  const filter = (label: string, value: string) => { let node = container.querySelector<HTMLSelectElement>(`[aria-label="${label} filter"]`);
    if (!node) { act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Filter"]')!.click());
      node = container.querySelector<HTMLSelectElement>(`[aria-label="${label} filter"]`); }
    if (!node) throw new Error(`Missing ${label} filter`);
    act(() => { node.value = value; node!.dispatchEvent(new Event("change", { bubbles: true })); }); };
  const sort = (label: string) => { act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Sort recipes"]')!.click());
    act(() => button(label).click()); };

  it("reprojects for marked, added, scheduled tri-state and same-marked plan.days changes", () => {
    const marked = ["Soup"]; const days = new Map([["2026-09-02", ["Soup"]], ["2026-09-01", ["Salad"]]]);
    render(baseRecipes, plan(marked, days));
    filter("Marked", "marked"); expect(paths()).toEqual(["recipes/soup.md"]);
    filter("Marked", "all"); filter("Added date", "last-7-days"); expect(paths()).toEqual(["recipes/soup.md", "recipes/salad.md"]);
    filter("Added date", "all"); sort("Scheduled (latest)"); expect(paths()).toEqual(["recipes/soup.md", "recipes/salad.md", "recipes/stew.md"]);
    render(baseRecipes, plan(marked, new Map([["2026-09-01", ["Soup"]], ["2026-09-02", ["Salad"]]])));
    expect(paths()).toEqual(["recipes/salad.md", "recipes/soup.md", "recipes/stew.md"]);
    filter("Scheduled", "unscheduled"); expect(paths()).toEqual(["recipes/stew.md"]);
    filter("Scheduled", "scheduled"); expect(paths()).toEqual(["recipes/salad.md", "recipes/soup.md"]);
  });

  it.each([[false, "settle"], [true, "settle"], [false, "reject"], [true, "reject"]] as const)(
    "owns optimistic %s→%s and authoritative %s", async (initial, outcome) => {
      const pending = deferred(); callbacks.onToggleMarked.mockReturnValueOnce(pending.promise); if (outcome === "reject") vi.spyOn(console, "error").mockImplementation(() => undefined);
      const only = recipe("recipes/card.md", "Card"); render([only], plan(initial ? ["Card"] : []));
      const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!; act(() => checkbox.click());
      expect([checkbox.checked, checkbox.disabled]).toEqual([!initial, true]); expect(callbacks.onToggleMarked).toHaveBeenCalledWith(only.path, !initial);
      if (outcome === "reject") await act(async () => { pending.reject(new Error("failed")); await pending.promise.catch(() => undefined); });
      else { render([only], plan(!initial ? ["Card"] : [])); await act(async () => { pending.resolve(); await pending.promise; }); }
      expect([checkbox.checked, checkbox.disabled]).toEqual([outcome === "reject" ? initial : !initial, false]);
      if (!initial && outcome === "settle") { render([only], plan()); expect(checkbox.checked).toBe(false); }
    });

});
