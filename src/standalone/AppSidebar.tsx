import * as React from "react";
import { setIcon } from "@/platform-primitives";

export type SidebarView = "planner" | "database" | "shopping" | "settings" | "recipe";

type AppSidebarProps = {
  activeView: SidebarView;
  canGoBack: boolean;
  onBack: () => void;
  onNavigate: (view: Exclude<SidebarView, "recipe">) => void;
  onPreparePlanner?: () => void;
  onPrepareShopping?: () => void;
};

function iconRef(icon: string): React.RefCallback<HTMLSpanElement> {
  return (element) => { if (element) setIcon(element, icon); };
}

const NAV_ITEMS = [
  { view: "database", label: "Recipe Database", iconRef: iconRef("layout-grid") },
  { view: "planner", label: "Planner", iconRef: iconRef("calendar-days") },
  { view: "shopping", label: "Shopping List", iconRef: iconRef("shopping-cart") },
  { view: "settings", label: "Settings", iconRef: iconRef("settings") },
] as const;

/** Icon-only rail. There is one width, so nothing here expands or remembers a width. */
export function AppSidebar({
  activeView,
  canGoBack,
  onBack,
  onNavigate,
  onPreparePlanner,
  onPrepareShopping,
}: AppSidebarProps): React.JSX.Element {
  return (
    <aside className="mep-sidebar">
      <button
        className={`mep-sidebar__back ${canGoBack ? "" : "is-disabled"}`}
        type="button"
        onClick={onBack}
        disabled={!canGoBack}
        title="Go back"
        ref={(element) => { if (element) setIcon(element, "arrow-left"); }}
      />
      <nav className="mep-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            className={`mep-nav__item ${activeView === item.view ? "is-active" : ""}`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (item.view === "planner") onPreparePlanner?.();
              if (item.view === "shopping") onPrepareShopping?.();
            }}
            onPointerUp={(event) => {
              if (event.button === 0) onNavigate(item.view);
            }}
            onClick={(event) => {
              if (event.detail === 0) onNavigate(item.view);
            }}
            title={item.label}
          >
            <span
              className="mep-nav__icon"
              aria-hidden="true"
              ref={item.iconRef}
            />
            {/* Read out and matchable, but never drawn: the rail shows icons only. */}
            <span className="mep-sr-only">{item.label}</span>
          </button>
        ))}
      </nav>
      {/* Decorative: the app is already named by the page h1, so this adds no second label. */}
      <img className="mep-sidebar__mark" src="/enplace-mark.png" alt="" width={128} height={100} />
    </aside>
  );
}
