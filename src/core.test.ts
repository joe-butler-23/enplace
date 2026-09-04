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
  resolveRecipeReference,
  resolveRelativePath,
  scanRecipes,
  serializePlan,
  shoppingPlainText,
  toggleShoppingItem,
  withRecipePlanning,
} from "./core";

describe("plain Markdown recipe rule", () => {

  it("keeps machine references identical under en-GB and tr-TR case rules", () => {
    expect("I".toLocaleLowerCase("en-GB")).not.toBe("I".toLocaleLowerCase("tr-TR"));
    const recipe = parseRecipe("I.md", "# I\n\n## Ingredients\n- onion\n");
    expect(resolveRecipeReference([recipe!], "i")).toBe(recipe);
  });

  it("accepts only a level-two Ingredients heading and keeps free-form bullets opaque", () => {
    expect(parseRecipe("recipes/a.md", "# A\n\n# Ingredients\n- no\n")).toBeNull();
    expect(parseRecipe("recipes/a.md", "# A\n\n### Ingredients\n- no\n")).toBeNull();
    expect(parseRecipe("recipes/a.md", "```md\n## Ingredients\n- code only\n```\n")).toBeNull();
    const recipe = parseRecipe("recipes/a.md", "# A\n\n## iNgReDiEnTs\n- 2 onions, sliced\n- 1 | lime | produce\n\n## Method\n1. Stir\n- Serve\n");
    expect(recipe?.ingredients).toEqual(["2 onions, sliced", "1 | lime | produce"]);
  });

  it("uses frontmatter title, then H1, then filename and finds the first body image", () => {
    expect(parseRecipe("a.md", "---\ntitle: Front\n---\n# Body\n## Ingredients\n- x")?.title).toBe("Front");
    expect(parseRecipe("a.md", "# Body\n## Ingredients\n- x")?.title).toBe("Body");
    const fallback = parseRecipe("nested/file-name.md", "![dish](../images/dish.jpg)\n## Ingredients\n- x");
    expect(fallback?.title).toBe("file-name");
    expect(fallback?.cover).toBe("../images/dish.jpg");
    expect(resolveRelativePath(fallback!.path, fallback!.cover!)).toBe("images/dish.jpg");
  });

  it("keeps duplicate titles and qualifies case-colliding stems", () => {
    const recipes = scanRecipes([
      { path: "recipes/Soup.md", text: "---\ntitle: Shared Supper\n---\n## Ingredients\n- a" },
      { path: "archive/soup.MD", text: "---\ntitle: Shared Supper\n---\n## Ingredients\n- b" },
      { path: "salad.md", text: "## Ingredients\n- c" },
    ]);
    expect(recipes.map(({ path, title, link }) => ({ path, title, link }))).toEqual([
      { path: "salad.md", title: "salad", link: "salad" },
      { path: "recipes/Soup.md", title: "Shared Supper", link: "recipes/Soup" },
      { path: "archive/soup.MD", title: "Shared Supper", link: "archive/soup" },
    ]);
  });
});

describe("Plan.md", () => {
  it("round-trips marked recipes and sorted non-empty days into the canonical file", () => {
    const parsed = parsePlan("preamble ignored\n## 2026-09-09\n- [[soup]]\n## Marked\n- [[salad]]\n- [[salad]]\n## 2026-09-07\n- [[pie]]\n## empty\n- [[ignored]]\n");
    expect(parsed.marked).toEqual(["salad"]);
    expect(serializePlan(parsed)).toBe("## Marked\n- [[salad]]\n\n## 2026-09-07\n- [[pie]]\n\n## 2026-09-09\n- [[soup]]\n");
    expect(serializePlan(parsePlan(serializePlan(parsed)))).toBe(serializePlan(parsed));
  });

  it("round-trips day notes and keeps a noted day with no recipes", () => {
    const parsed = parsePlan("## Marked\n\n## 2026-09-04\n> Grandma visiting, cook early\n- [[recipes/lasagne]]\n\n## 2026-09-05\n> Eat out\n");
    expect(parsed.notes).toEqual(new Map([
      ["2026-09-04", "Grandma visiting, cook early"],
      ["2026-09-05", "Eat out"],
    ]));
    expect(serializePlan(parsed)).toBe("## Marked\n\n## 2026-09-04\n> Grandma visiting, cook early\n- [[recipes/lasagne]]\n\n## 2026-09-05\n> Eat out\n");
    expect(parsePlan(serializePlan(parsed)).notes).toEqual(parsed.notes);
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
  it("rebuilds exact Markdown in plan order by distinct recipe identity", () => {
    const sameA = parseRecipe("a/same.md", "---\ntitle: Same\n---\n## Ingredients\n- Salt\n- apples\n")!;
    const sameB = parseRecipe("b/same.md", "---\ntitle: Same\n---\n## Ingredients\n- salt\n- pears\n- pears\n")!;
    const current = "# Shopping\r\n\r\n## Market note\r\nBuy local\r\n- [ ] hand soap\r\n\r\n## Same\r\n- [x] SALT\r\n- [ ] stale\r\n\r\n## AI grouping\r\n- [x] batteries\r\n";
    const duplicatePath = { ...sameB, title: "Ignored duplicate", ingredients: ["wrong"] };
    expect(buildShoppingMarkdown(current, [sameB, sameA, duplicatePath], [sameA, sameB])).toBe(
      "# Shopping\r\n\r\n## Market note\r\nBuy local\r\n- [ ] hand soap\r\n\r\n## AI grouping\r\n- [x] batteries\r\n\n## Same\n- [x] salt\n- [ ] pears\n\n## Same\n- [ ] apples\n",
    );
  });

  it("adds under Other and removes exactly the selected Markdown line", () => {
    const added = appendShoppingItem("## Soup\n- [ ] onion\n", "hand soap");
    expect(added).toBe("## Soup\n- [ ] onion\n\n## Other\n- [ ] hand soap\n");
    const reused = appendShoppingItem("## Other\n- [ ] hand soap\n\n## Soup\n- [ ] onion\n", "foil");
    expect(reused).toContain("## Other\n- [ ] hand soap\n- [ ] foil\n\n## Soup");
    expect(removeShoppingItem(reused, 1, "hand soap")).not.toContain("hand soap");
    expect(removeShoppingItem(reused, 1, "hand soap")).toContain("- [ ] foil");
  });

  it("merges a date heading that a concurrent edit duplicated", () => {
    const plan = parsePlan("## Marked\n\n## 2026-09-04\n- [[alpha]]\n\n## 2026-09-04\n- [[beta]]\n");
    expect(plan.days.get("2026-09-04")).toEqual(["alpha", "beta"]);
    expect(serializePlan(plan)).toBe("## Marked\n\n## 2026-09-04\n- [[alpha]]\n- [[beta]]\n");
  });

  it("toggles exactly one source line and copies without checkbox markers", () => {
    const markdown = "## Soup\n- [ ] onion\n- [x] stock\n";
    const toggled = toggleShoppingItem(markdown, 1, "onion", true);
    expect(parseShopping(toggled)).toEqual([
      { line: 1, heading: "Soup", text: "onion", checked: true },
      { line: 2, heading: "Soup", text: "stock", checked: true },
    ]);
    expect(shoppingPlainText(toggled)).toBe("## Soup\nonion\nstock\n");
  });
  it("targets shopping mutations by item text after unrelated lines move", () => {
    const moved = "# note\n\n## Soup\n- [ ] onion\n- [ ] stock\n";
    expect(toggleShoppingItem(moved, 2, "stock", true)).toContain("- [ ] onion\n- [x] stock");
    expect(removeShoppingItem(moved, 1, "onion")).toContain("- [ ] stock");
  });

  it("uses the selected line when shopping items have identical text", () => {
    const duplicate = "## Other\n- [ ] milk\n- [ ] milk\n";
    const secondTicked = toggleShoppingItem(duplicate, 2, "milk", true);
    expect(secondTicked).toBe("## Other\n- [ ] milk\n- [x] milk\n");
    expect(toggleShoppingItem(secondTicked, 1, "milk", true)).toBe("## Other\n- [x] milk\n- [x] milk\n");
    expect(removeShoppingItem(duplicate, 2, "milk")).toBe("## Other\n- [ ] milk\n");
    expect(() => toggleShoppingItem(duplicate, 9, "milk", true)).toThrow("Shopping item no longer exists");
  });

});

describe("paste import", () => {
  it("writes plain ingredient and method lines with optional provenance", () => {
    expect(renderImportedRecipe({ title: "Soup", source: "https://example.com", ingredients: ["one onion"], method: ["1. Stir"] }))
      .toContain("# Soup\n\nSource: https://example.com\n\n---\n\n- one onion\n\n---\n\n1. Stir\n");
  });

  it("keeps an item whose box was doubled by a concurrent tick and repairs it on the next toggle", () => {
    const merged = "## Soup\n- [xx] onion\n- [  ] stock\n";
    expect(parseShopping(merged)).toEqual([
      { line: 1, heading: "Soup", text: "onion", checked: true },
      { line: 2, heading: "Soup", text: "stock", checked: false },
    ]);
    expect(toggleShoppingItem(merged, 1, "onion", false)).toBe("## Soup\n- [ ] onion\n- [  ] stock\n");
    expect(toggleShoppingItem(merged, 2, "stock", true)).toBe("## Soup\n- [xx] onion\n- [x] stock\n");
  });
});
