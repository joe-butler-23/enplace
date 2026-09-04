// @vitest-environment happy-dom
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const commitStates = vi.hoisted(() => [] as boolean[]);
vi.mock("./standalone/storage", () => ({ loadSettings: vi.fn().mockResolvedValue({}),
  prepareStandaloneStartup: vi.fn(async (settings: unknown) => settings), saveSettings: vi.fn() }));
vi.mock("./kitchen/store", () => { const plan = { marked: [], days: new Map(), notes: new Map() };
  const snapshot = { revision: 1, files: [], imageUrls: new Map(), recipes: [], plan, shopping: { items: [] } };
  return { getKitchenSnapshot: () => snapshot, useKitchenSlice: (slice: keyof typeof snapshot) => snapshot[slice], useKitchenText: () => null }; });
vi.mock("./standalone/AppSidebar", async () => { const React = await import("react"); return { AppSidebar: ({ activeView, onNavigate }:
  { activeView: string; onNavigate: (view: "database" | "shopping" | "planner") => void }) => { React.useLayoutEffect(() => {
    if (activeView === "database") commitStates.push(document.querySelector('[data-testid="database"]') !== null); }, [activeView]);
    return <><button type="button" onClick={() => onNavigate("database")}>Database</button>
      <button type="button" onClick={() => onNavigate("shopping")}>Shopping</button>
      <button type="button" onClick={() => onNavigate("planner")}>Planner</button></>; } }; });
vi.mock("@/views/components/CookingDatabase", () => ({ CookingDatabase: () => <div data-testid="database">Database content</div> }));
vi.mock("./views/components/ShoppingListView", () => ({ ShoppingListView: () => <div data-testid="shopping">Shopping content</div> }));
vi.mock("./views/components/AppOverlays", () => ({ CommandPalette: () => null, HelpDialog: () => null, Notices: () => null,
  SettingsDialog: () => null, StartupFailure: () => null }));
vi.mock("./kitchen/KitchenPanel", () => ({ ShareKitchenDialog: () => null }));
vi.mock("./views/components/PreviewPane", () => ({ PreviewPane: () => null }));
vi.mock("./views/components/RecipeView", () => ({ RecipeView: () => null }));
import { PlannerOrderStore } from "./modules/organiser/utils/planner-order";
import App from "./App";
describe("App database residency", () => {
  let container: HTMLDivElement; let root: Root;
  beforeEach(() => { commitStates.length = 0; window.history.replaceState(null, "", "/shopping");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); });
  it("mounts Database in the first navigation commit from direct Shopping", async () => {
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="shopping"]')).not.toBeNull());
    await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    expect(commitStates).toEqual([true]); expect(container.querySelector('.mep-database-panel > [data-testid="database"]')?.textContent).toBe("Database content");
  });
  it("keeps Database mounted and hidden after navigating away", async () => {
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull());
    const click = async (label: string) => { const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === label)!;
      await act(async () => { button.click(); await Promise.resolve(); }); };
    await click("Database"); await click("Shopping");
    const database = container.querySelector('[data-testid="database"]');
    expect(database).not.toBeNull(); expect(database?.closest<HTMLElement>(".mep-view")?.hidden).toBe(true);
    expect(container.querySelector('[data-testid="shopping"]')).not.toBeNull();
  });

  it("keeps planner load failure visible while the current view remains mounted", async () => {
    vi.spyOn(PlannerOrderStore.prototype, "load").mockRejectedValueOnce(new Error("order failed"));
    await act(async () => { root.render(<App />); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull());
    const planner = [...container.querySelectorAll("button")].find((button) => button.textContent === "Planner")!;
    await act(async () => { planner.click(); await Promise.resolve(); });
    await vi.waitFor(() => expect(container.querySelector(".mep-planner-intent-error")?.textContent)
      .toContain("Planner failed to load: order failed"));
    expect(container.querySelector('[data-testid="shopping"]')).not.toBeNull();
  });

});
