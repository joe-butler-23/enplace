import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { groupShoppingItems, shoppingErrorText, ShoppingListView, visibleGroups } from "./ShoppingListView";
import type { ShoppingList } from "@/views/components/ShoppingListView";

const list: ShoppingList = { items: [
  { id: "tomato", content: "2 tomatoes", labels: [], sources: ["Soup"], checked: false },
  { id: "salt", content: "salt", labels: [], sources: ["Soup", "Bread"], checked: true },
  { id: "flour", content: "500g flour", labels: [], sources: ["Bread"], checked: false },
] };

const props = {
  list,
  busy: false,
  error: null,
  onCheck: vi.fn(),
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onCopyLink: vi.fn(),
};

describe("ShoppingListView Markdown presentation", () => {
  it("groups deterministic shopping lines by recipe", () => {
    expect(groupShoppingItems(list.items, "recipe").map((group) => group.label)).toEqual([
      "Soup", "Shared ingredients", "Bread"
    ]);
  });

  it("renders recipe groups with Markdown add/remove controls and Copy list", () => {
    const html = renderToStaticMarkup(<ShoppingListView {...props} />);
    expect(html).toContain("Shopping list");
    expect(html).toContain("Soup");
    expect(html).toContain("Bread");
    expect(html).toContain("Copy list");
    expect(html).not.toContain(">Refresh<");
    expect(html).not.toContain(">Retry<");
    expect(html).not.toContain("Roll back");
    expect(html).toContain('aria-label="Add an item"');
    expect(html).toContain('aria-label="Remove 2 tomatoes"');
    expect(html).not.toContain("One aisle at a time");
  });

  it("drops checked items and empty groups when hiding done items", () => {
    const groups = groupShoppingItems(list.items, "recipe");
    expect(visibleGroups(groups, true).flatMap((group) => group.items).map((item) => item.id))
      .toEqual(["tomato", "flour"]);
  });

  it("keeps diagnostic detail out of the visible error", () => {
    expect(shoppingErrorText("write failed\nstack detail")).toBe("write failed");
  });
});
