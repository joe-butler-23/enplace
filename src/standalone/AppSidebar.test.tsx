// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSidebar, type SidebarView } from "./AppSidebar";

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
});

describe("AppSidebar", () => {
  it("navigates Settings from clicks, but other items from pointerup", () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onNavigate = vi.fn();
    const onHelp = vi.fn();
    flushSync(() => root.render(
      <AppSidebar
        activeView="database"
        canGoBack={false}
        onBack={vi.fn()}
        onNavigate={onNavigate}
        onHelp={onHelp}
      />,
    ));

    const settingsButton = container.querySelector<HTMLButtonElement>('[title="Settings"]')!;
    settingsButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    expect(onNavigate).not.toHaveBeenCalled();
    settingsButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onNavigate).toHaveBeenLastCalledWith("settings");
    settingsButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(onNavigate).toHaveBeenLastCalledWith("settings");
    expect(onNavigate).toHaveBeenCalledTimes(2);

    const databaseButton = container.querySelector<HTMLButtonElement>('[title="Recipe Database"]')!;
    databaseButton.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    expect(onNavigate).toHaveBeenLastCalledWith("database");
    expect(onNavigate).toHaveBeenCalledTimes(3);
    flushSync(() => root.unmount());
  });

  it("opens Help from a click", () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onHelp = vi.fn();
    flushSync(() => root.render(<AppSidebar activeView="database" canGoBack={false} onBack={vi.fn()} onNavigate={vi.fn()} onHelp={onHelp} />));
    container.querySelector<HTMLButtonElement>('[title="Help"]')?.click();
    expect(onHelp).toHaveBeenCalledOnce();
    flushSync(() => root.unmount());
  });

  it("keeps each nav icon element mounted when the sidebar re-renders during a press", () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (activeView: SidebarView) => (
      <AppSidebar
        activeView={activeView}
        canGoBack={false}
        onBack={vi.fn()}
        onNavigate={vi.fn()}
        onHelp={vi.fn()}
      />
    );

    flushSync(() => root.render(render("database")));
    const shoppingButton = container.querySelector<HTMLButtonElement>('[title="Shopping List"]');
    const iconBeforePress = shoppingButton?.querySelector("svg");
    expect(iconBeforePress).toBeInstanceOf(SVGElement);

    shoppingButton?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    flushSync(() => root.render(render("planner")));

    expect(shoppingButton?.querySelector("svg")).toBe(iconBeforePress);
    flushSync(() => root.unmount());
  });
});
