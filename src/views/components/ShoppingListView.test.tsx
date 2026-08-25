import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveGrouping,
  groupShoppingItems,
  nextGroupLabel,
  shoppingErrorText,
  shoppingSections,
  ShoppingListView,
  visibleGroups
} from "./ShoppingListView";

const item = {
  id: "milk",
  content: "milk - 1 litre",
  labels: ["dairy"],
  sources: ["Pancakes"],
  checked: false
};

const groups = [
  { label: "bakery", items: [{ ...item, id: "bread", content: "bread", checked: true }] },
  { label: "dairy", items: [item, { ...item, id: "butter", content: "butter", checked: true }] }
];

const baseProps = {
  plan: null,
  busy: false,
  error: null,
  onApply: vi.fn(),
  onCheck: vi.fn(),
  onRollback: vi.fn(),
  onRefresh: vi.fn()
};

describe("ShoppingListView", () => {
  it("shows the weekly preview before apply", () => {
    const html = renderToStaticMarkup(
      <ShoppingListView
        {...baseProps}
        list={null}
        plan={{
          baseRevision: 2,
          weekLabel: "This week",
          items: [item],
          summary: {
            currentCount: 0,
            desiredCount: 1,
            unchangedCount: 0,
            createCount: 1,
            deleteCount: 0,
            manualCount: 2
          }
        }}
        onCopyLink={vi.fn()}
      />
    );
    expect(html).toContain("Preview: This week");
    expect(html).toContain("milk - 1 litre");
    expect(html).toContain("Apply list");
    expect(html).toContain("2 of yours kept");
    // Zero-valued numbers are omitted rather than shown.
    expect(html).not.toContain("0 removed");
  });

  it("puts the whole header on one row and drops the progress readout", () => {
    const html = renderToStaticMarkup(
      <ShoppingListView
        {...baseProps}
        list={{
          schemaVersion: 1,
          revision: 3,
          weekLabel: "Aug 10 - Aug 16",
          items: [{ ...item, checked: true }, { ...item, id: "eggs", content: "eggs" }],
          rollback: { weekLabel: "Last week", items: [] }
        }}
      />
    );
    expect(html).toContain("Aug 10 - Aug 16");
    expect(html).toContain("checked=\"\"");
    expect(html).toContain("is-checked");
    // Grouping is a three-way segmented control in the header.
    for (const label of [">None<", ">Aisle<", ">Recipe<"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Hide done items");
    // No progress bar, no "N of M picked up", no separate controls row.
    expect(html).not.toContain("progressbar");
    expect(html).not.toContain("picked up");
    expect(html).not.toContain("shopping-list-view__controls");
    expect(html).not.toContain("shopping-toggle");
  });

  it("shows the grouping actually in effect, not the stored preference", () => {
    // Walking one aisle at a time forces aisle grouping, so the control must not keep
    // highlighting Recipe while the tabs are showing aisles.
    const list = {
      schemaVersion: 1,
      revision: 1,
      weekLabel: "This week",
      items: [item],
      rollback: null
    };
    const html = renderToStaticMarkup(<ShoppingListView {...baseProps} list={list} />);
    const active = html.slice(html.indexOf("shopping-seg"), html.indexOf("shopping-icon-toggle"));
    // Default is aisle grouping, and only one option may read as active.
    expect((active.match(/is-active/g) ?? []).length).toBe(1);
    expect(active.slice(active.indexOf("is-active"))).toContain("Aisle");
  });

  it("moves one-aisle-at-a-time and the rest of the actions into the overflow", () => {
    const html = renderToStaticMarkup(
      <ShoppingListView
        {...baseProps}
        list={{
          schemaVersion: 1,
          revision: 3,
          weekLabel: "This week",
          items: [item],
          rollback: { weekLabel: "Last week", items: [] }
        }}
        onCopyLink={vi.fn()}
      />
    );
    const panel = html.slice(html.indexOf("shopping-menu__panel"), html.indexOf("</details>"));
    for (const label of ["One aisle at a time", "Refresh", "Copy link", "Roll back previous list"]) {
      expect(panel).toContain(label);
    }
  });

  it("carries no provenance or marker in the row itself", () => {
    const html = renderToStaticMarkup(
      <ShoppingListView
        {...baseProps}
        list={{
          schemaVersion: 1,
          revision: 1,
          weekLabel: "This week",
          items: [item, { ...item, id: "loo", content: "loo roll", sources: [], manual: true }],
          rollback: null
        }}
        onRemove={vi.fn()}
      />
    );
    expect(html).toContain("milk - 1 litre");
    expect(html).toContain("loo roll");
    // Provenance comes from choosing Recipe grouping, not a slot on every row.
    expect(html).not.toContain("Pancakes");
    expect(html).not.toContain("shopping-item__meta");
    expect(html).not.toContain(">added<");
    expect(html).toContain('aria-label="Remove loo roll"');
  });

  it("collapses the composer to one affordance until it is needed", () => {
    const list = {
      schemaVersion: 1,
      revision: 3,
      weekLabel: "This week",
      items: [item],
      rollback: null
    };
    expect(renderToStaticMarkup(<ShoppingListView {...baseProps} list={list} />))
      .not.toContain("shopping-fab");
    const withAdd = renderToStaticMarkup(
      <ShoppingListView {...baseProps} list={list} onAdd={vi.fn()} />
    );
    expect(withAdd).toContain("shopping-fab");
    expect(withAdd).not.toContain("shopping-composer__input");
  });

  it("says nothing about the list until it has actually loaded", () => {
    const loading = renderToStaticMarkup(
      <ShoppingListView {...baseProps} list={null} onAdd={vi.fn()} />
    );
    expect(loading).not.toContain("empty");
    // Adding against an unloaded list would send revision 0 and be rejected as stale.
    expect(loading).not.toContain("shopping-fab");

    const loadedEmpty = renderToStaticMarkup(
      <ShoppingListView
        {...baseProps}
        list={{ schemaVersion: 1, revision: 1, weekLabel: "", items: [], rollback: null }}
      />
    );
    expect(loadedEmpty).toContain("Your list is empty");
    expect(loadedEmpty).toContain("Shopping list");
  });

  it("puts a revision conflict in plain language, since it self-heals", () => {
    expect(shoppingErrorText("Stale shopping list revision: expected 0, current 3"))
      .toBe("The list changed somewhere else, so it has been reloaded. Try that again.");
    expect(shoppingErrorText("Shopping item not found: abc\nError: Shopping item not found: abc"))
      .toBe("Shopping item not found: abc");
  });
});

describe("shopping list grouping", () => {
  it("groups recipe ingredients without parsing their display text", () => {
    const grouped = groupShoppingItems([
      item,
      { ...item, id: "onion", content: "onion", sources: ["Soup", "Curry"] },
      { ...item, id: "bread", content: "bread", labels: ["bakery"], sources: [] }
    ], "recipe");

    expect(grouped.map((group) => group.label)).toEqual([
      "Pancakes",
      "Shared ingredients",
      "Other"
    ]);
    expect(grouped[1].items[0].content).toBe("onion");
  });

  it("collapses to a single unlabelled group when grouping is off", () => {
    const flat = groupShoppingItems([item, { ...item, id: "bread", labels: ["bakery"] }], "none");
    expect(flat).toHaveLength(1);
    expect(flat[0].label).toBe("");
    expect(flat[0].items).toHaveLength(2);
    expect(groupShoppingItems([], "none")).toEqual([]);
  });

  it("forces aisle grouping while walking one aisle at a time", () => {
    // Otherwise the tabs would name recipes, or collapse to one unnamed group.
    expect(effectiveGrouping(true, "recipe")).toBe("section");
    expect(effectiveGrouping(true, "none")).toBe("section");
    expect(effectiveGrouping(false, "recipe")).toBe("recipe");
    expect(effectiveGrouping(false, "none")).toBe("none");
  });

  it("collapses emptied groups when done items are hidden", () => {
    expect(visibleGroups(groups, false)).toEqual(groups);

    const shown = visibleGroups(groups, true);
    expect(shown.map((group) => group.label)).toEqual(["dairy"]);
    expect(shown[0].items.map((entry) => entry.id)).toEqual(["milk"]);
    expect(groups[1].items).toHaveLength(2);
  });

  it("advances aisles with a wrap and recovers from a stale active label", () => {
    expect(nextGroupLabel(groups, "bakery")).toBe("dairy");
    expect(nextGroupLabel(groups, "dairy")).toBe("bakery");
    expect(nextGroupLabel(groups, "produce")).toBe("bakery");
    expect(nextGroupLabel([], "dairy")).toBeNull();
  });

  it("offers each section on the list once, sorted", () => {
    expect(
      shoppingSections([
        { ...item, labels: ["dairy"] },
        { ...item, labels: [" dairy "] },
        { ...item, labels: ["bakery"] },
        { ...item, labels: [""] }
      ])
    ).toEqual(["bakery", "dairy"]);
  });
});
