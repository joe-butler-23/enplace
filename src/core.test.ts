import { describe, expect, it } from "vitest";
import {
  appendShoppingItem,
  buildShoppingMarkdown,
  parsePlan,
  parseRecipe,
  parseShopping,
  removeShoppingItem,
  renderImportedRecipe,
  recipePlanning,
  replaceRecipeDocument,
  resolveRelativePath,
  scanRecipes,
  serializePlan,
  shoppingPlainText,
  toggleShoppingItem,
  withRecipePlanning,
} from "./core";

describe("plain Markdown recipe rule", () => {
  it("accepts only a level-two Ingredients heading and keeps free-form bullets opaque", () => {
    expect(parseRecipe("recipes/a.md", "# A\n\n# Ingredients\n- no\n")).toBeNull();
    expect(parseRecipe("recipes/a.md", "# A\n\n### Ingredients\n- no\n")).toBeNull();
    expect(parseRecipe("recipes/a.md", "```md\n## Ingredients\n- code only\n```\n")).toBeNull();
    const recipe = parseRecipe("recipes/a.md", "# A\n\n## iNgReDiEnTs\n- 2 onions, sliced\n- 1 | lime | produce\n\n## Method\n1. Stir\n- Serve\n");
    expect(recipe?.ingredients).toEqual(["2 onions, sliced", "1 | lime | produce"]);
    expect(recipe?.method).toEqual(["Stir", "Serve"]);
  });

  it("uses frontmatter title, then H1, then filename and finds the first body image", () => {
    expect(parseRecipe("a.md", "---\ntitle: Front\n---\n# Body\n## Ingredients\n- x")?.title).toBe("Front");
    expect(parseRecipe("a.md", "# Body\n## Ingredients\n- x")?.title).toBe("Body");
    const fallback = parseRecipe("nested/file-name.md", "![dish](../images/dish.jpg)\n## Ingredients\n- x");
    expect(fallback?.title).toBe("file-name");
    expect(fallback?.cover).toBe("../images/dish.jpg");
    expect(resolveRelativePath(fallback!.path, fallback!.cover!)).toBe("images/dish.jpg");
  });

  it("uses relative paths only when duplicate stems make wikilinks ambiguous", () => {
    const recipes = scanRecipes([
      { path: "one/soup.md", text: "## Ingredients\n- a" },
      { path: "two/soup.md", text: "## Ingredients\n- b" },
      { path: "salad.md", text: "## Ingredients\n- c" },
    ]);
    expect(Object.fromEntries(recipes.map((recipe) => [recipe.path, recipe.link]))).toEqual({
      "salad.md": "salad",
      "one/soup.md": "one/soup",
      "two/soup.md": "two/soup",
    });
  });

  it("keeps a duplicate-stem recipe's qualified plan link after editing", () => {
    const recipes = scanRecipes([
      { path: "one/soup.md", text: "# One soup\n\n## Ingredients\n- onion" },
      { path: "two/soup.md", text: "# Two soup\n\n## Ingredients\n- carrot" },
    ]);
    const updated = replaceRecipeDocument(recipes, "one/soup.md", "# Edited soup\n\n## Ingredients\n- leek");
    expect(updated.find((recipe) => recipe.path === "one/soup.md")?.link).toBe("one/soup");
  });
});

describe("Plan.md", () => {
  it("round-trips marked recipes and sorted non-empty days into the canonical file", () => {
    const parsed = parsePlan("preamble ignored\n## 2026-09-09\n- [[soup]]\n## Marked\n- [[salad]]\n- [[salad]]\n## 2026-09-07\n- [[pie]]\n## empty\n- [[ignored]]\n");
    expect(serializePlan(parsed)).toBe("## Marked\n- [[salad]]\n\n## 2026-09-07\n- [[pie]]\n\n## 2026-09-09\n- [[soup]]\n");
    expect(serializePlan(parsePlan(serializePlan(parsed)))).toBe(serializePlan(parsed));
  });

  it("replaces one recipe's marked and multi-date planning without changing other recipes", () => {
    const current = parsePlan("## Marked\n- [[soup]]\n\n## 2026-09-07\n- [[soup]]\n- [[pie]]\n");
    const next = withRecipePlanning(current, "soup", {
      marked: false,
      scheduledDates: ["2026-09-09", "invalid", "2026-09-08", "2026-09-09"],
    });
    expect(recipePlanning(next, "soup")).toEqual({
      marked: false,
      scheduledDates: ["2026-09-08", "2026-09-09"],
    });
    expect(next.days.get("2026-09-07")).toEqual(["pie"]);
  });

  it("preserves existing day order when marked or other dates change", () => {
    const current = parsePlan("## 2026-09-07\n- [[soup]]\n- [[pie]]\n\n## 2026-09-08\n- [[salad]]\n- [[soup]]\n");
    const next = withRecipePlanning(current, "soup", {
      marked: true,
      scheduledDates: ["2026-09-07", "2026-09-08", "2026-09-09"],
    });
    expect(next.days.get("2026-09-07")).toEqual(["soup", "pie"]);
    expect(next.days.get("2026-09-08")).toEqual(["salad", "soup"]);
    expect(next.days.get("2026-09-09")).toEqual(["soup"]);
  });
});

describe("Shopping.md", () => {
  const soup = parseRecipe("soup.md", "---\ntitle: Soup\n---\n## Ingredients\n- 2 onions\n- Salt\n")!;
  const pie = parseRecipe("pie.md", "---\ntitle: Pie\n---\n## Ingredients\n- salt\n- Flour\n")!;

  it("rebuilds recipe sections in plan order, merges exact duplicates, and preserves checked state and hand sections", () => {
    const current = "# Shopping\n\n## Market note\nBuy local\n- [ ] hand soap\n\n## Soup\n- [x] 2 onions\n- [x] Old ingredient\n\n## AI grouping\n- [x] batteries\n";
    const built = buildShoppingMarkdown(current, [soup, pie], [soup, pie]);
    expect(built).toContain("## Market note\nBuy local\n- [ ] hand soap");
    expect(built).toContain("## AI grouping\n- [x] batteries");
    expect(built).not.toContain("Old ingredient");
    expect(built).toContain("## Soup\n- [x] 2 onions\n- [ ] Salt");
    expect(built).toContain("## Pie\n- [ ] Flour");
    expect(built.match(/Salt/gi)).toHaveLength(1);
  });

  it("adds under Other and removes exactly the selected Markdown line", () => {
    const added = appendShoppingItem("## Soup\n- [ ] onion\n", "hand soap");
    expect(added).toBe("## Soup\n- [ ] onion\n\n## Other\n- [ ] hand soap\n");
    const reused = appendShoppingItem("## Other\n- [ ] hand soap\n\n## Soup\n- [ ] onion\n", "foil");
    expect(reused).toContain("## Other\n- [ ] hand soap\n- [ ] foil\n\n## Soup");
    expect(removeShoppingItem(reused, "hand soap")).not.toContain("hand soap");
    expect(removeShoppingItem(reused, "hand soap")).toContain("- [ ] foil");
  });

  it("merges a date heading that a concurrent edit duplicated", () => {
    const plan = parsePlan("## Marked\n\n## 2026-09-04\n- [[alpha]]\n\n## 2026-09-04\n- [[beta]]\n");
    expect(plan.days.get("2026-09-04")).toEqual(["alpha", "beta"]);
    expect(serializePlan(plan)).toBe("## Marked\n\n## 2026-09-04\n- [[alpha]]\n- [[beta]]\n");
  });

  it("toggles exactly one source line and copies without checkbox markers", () => {
    const markdown = "## Soup\n- [ ] onion\n- [x] stock\n";
    const toggled = toggleShoppingItem(markdown, "onion", true);
    expect(parseShopping(toggled)).toEqual([
      { line: 1, heading: "Soup", text: "onion", checked: true },
      { line: 2, heading: "Soup", text: "stock", checked: true },
    ]);
    expect(shoppingPlainText(toggled)).toBe("## Soup\nonion\nstock\n");
  });
  it("targets shopping mutations by item text after unrelated lines move", () => {
    const moved = "# note\n\n## Soup\n- [ ] onion\n- [ ] stock\n";
    expect(toggleShoppingItem(moved, "stock", true)).toContain("- [ ] onion\n- [x] stock");
    expect(removeShoppingItem(moved, "onion")).toContain("- [ ] stock");
  });

});

describe("paste import", () => {
  it("writes plain ingredient and method lines with optional provenance", () => {
    expect(renderImportedRecipe({ title: "Soup", source: "https://example.com", ingredients: ["one onion"], method: ["1. Stir"] }))
      .toContain("source: https://example.com\n---\n\n# Soup\n\n## Ingredients\n\n- one onion\n\n## Method\n\n1. Stir\n");
  });

  it("keeps an item whose box was doubled by a concurrent tick and repairs it on the next toggle", () => {
    const merged = "## Soup\n- [xx] onion\n- [  ] stock\n";
    expect(parseShopping(merged)).toEqual([
      { line: 1, heading: "Soup", text: "onion", checked: true },
      { line: 2, heading: "Soup", text: "stock", checked: false },
    ]);
    expect(toggleShoppingItem(merged, "onion", false)).toBe("## Soup\n- [ ] onion\n- [  ] stock\n");
    expect(toggleShoppingItem(merged, "stock", true)).toBe("## Soup\n- [xx] onion\n- [x] stock\n");
  });
});
