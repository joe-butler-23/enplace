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
