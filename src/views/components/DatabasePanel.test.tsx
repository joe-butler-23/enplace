// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STANDALONE_SETTINGS } from "@/standalone/settings";
import { DatabasePanel } from "./DatabasePanel";

vi.mock("./CookingDatabase", () => ({
  CookingDatabase: ({ state, onStateChange }: {
    state: { search: string; sort: string; marked: string; scheduled: string; added: string; tags: string[] };
    onStateChange: (state: unknown) => void;
  }) => <button onClick={() => onStateChange({ ...state, sort: "title-asc", marked: "marked" })}>Change view</button>
}));

let container: HTMLDivElement | undefined;
afterEach(() => {
  container?.remove();
  container = undefined;
});

describe("DatabasePanel preferences", () => {
  it("publishes changed sort and filters without persisting transient query state", () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onPreferencesChange = vi.fn();
    flushSync(() => root.render(
      <DatabasePanel
        settings={DEFAULT_STANDALONE_SETTINGS}
        revision={0}
        initialView={{ items: [], total: 0, availableTags: [], markedCount: 0 }}
        loadView={vi.fn().mockResolvedValue({ items: [], total: 0, availableTags: [], markedCount: 0 })}
        resolveCover={() => null}
        onOpenRecipe={vi.fn()}
        onToggleMarked={vi.fn()}
        onClearMarked={vi.fn()}
        onPreferencesChange={onPreferencesChange}
      />
    ));

    flushSync(() => container?.querySelector<HTMLButtonElement>("button")?.click());
    expect(onPreferencesChange).toHaveBeenCalledWith({
      databaseSort: "title-asc",
      databaseMarkedFilter: "marked",
      databaseScheduledFilter: "all"
    });
    expect(onPreferencesChange.mock.calls[0][0]).not.toHaveProperty("search");
    flushSync(() => root.unmount());
  });
});
