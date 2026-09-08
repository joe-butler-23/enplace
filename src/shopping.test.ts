import { describe, expect, it } from "vitest";
import {
  classifyShoppingPair,
  formatRational,
  mergeShoppingItems,
  normalizeShoppingNoun,
  parseRational,
  addRational,
  singularize,
  type ShoppingItem,
} from "./shopping.js";

const makeItem = (id: string, content: string, source = "Test", checked = false): ShoppingItem => ({
  id,
  content,
  labels: [],
  sources: [source],
  checked,
});

describe("morphological singularization and dialect canonicalization", () => {
  it("singularizes irregular and standard food plurals", () => {
    expect(singularize("tomatoes")).toBe("tomato");
    expect(singularize("potatoes")).toBe("potato");
    expect(singularize("leaves")).toBe("leaf");
    expect(singularize("halves")).toBe("half");
    expect(singularize("loaves")).toBe("loaf");
    expect(singularize("cherries")).toBe("cherry");
    expect(singularize("berries")).toBe("berry");
    expect(singularize("onions")).toBe("onion");
    expect(singularize("carrots")).toBe("carrot");
    expect(singularize("parsnips")).toBe("parsnip");
    expect(singularize("cloves")).toBe("clove");
  });

  it("normalizes transatlantic and regional produce synonyms", () => {
    expect(normalizeShoppingNoun("eggplant")).toBe(normalizeShoppingNoun("aubergine"));
    expect(normalizeShoppingNoun("eggplants")).toBe(normalizeShoppingNoun("aubergines"));
    expect(normalizeShoppingNoun("zucchini")).toBe(normalizeShoppingNoun("courgette"));
    expect(normalizeShoppingNoun("arugula")).toBe(normalizeShoppingNoun("rocket"));
    expect(normalizeShoppingNoun("scallion")).toBe(normalizeShoppingNoun("spring onion"));
    expect(normalizeShoppingNoun("scallions")).toBe(normalizeShoppingNoun("spring onions"));
    expect(normalizeShoppingNoun("rutabaga")).toBe(normalizeShoppingNoun("swede"));
    expect(normalizeShoppingNoun("bok choy")).toBe(normalizeShoppingNoun("pak choi"));
    expect(normalizeShoppingNoun("fresh cilantro")).toBe(normalizeShoppingNoun("fresh coriander leaf"));
    expect(normalizeShoppingNoun("white kidney bean")).toBe(normalizeShoppingNoun("cannellini bean"));
    expect(normalizeShoppingNoun("garbanzo bean")).toBe(normalizeShoppingNoun("chickpea"));
    expect(normalizeShoppingNoun("icing sugar")).toBe(normalizeShoppingNoun("powdered sugar"));
    expect(normalizeShoppingNoun("bicarbonate of soda")).toBe(normalizeShoppingNoun("baking soda"));
    expect(normalizeShoppingNoun("ground beef")).toBe(normalizeShoppingNoun("minced beef"));
  });

  it("classifies identical and synonym pairs as same", () => {
    expect(classifyShoppingPair("aubergine", "eggplant")).toEqual({ relation: "same", score: 1.0 });
    expect(classifyShoppingPair("courgettes", "zucchini")).toEqual({ relation: "same", score: 1.0 });
    expect(classifyShoppingPair("spring onions", "scallion")).toEqual({ relation: "same", score: 1.0 });
  });

  it("strictly refuses to merge culinary conflicts and adversarial pairs", () => {
    expect(classifyShoppingPair("black beans", "black bean sauce").relation).toBe("unknown");
    expect(classifyShoppingPair("rice noodles", "egg noodles").relation).toBe("unknown");
    expect(classifyShoppingPair("basil, fresh", "basil, dried").relation).toBe("unknown");
    expect(classifyShoppingPair("fresh ginger", "ground ginger").relation).toBe("unknown");
    expect(classifyShoppingPair("whole milk", "skimmed milk").relation).toBe("unknown");
    expect(classifyShoppingPair("coriander seed", "coriander leaf").relation).toBe("unknown");
  });
});

describe("preparation tail handling", () => {
  it("strips disposable kitchen preparation tails but retains purchase forms", () => {
    expect(normalizeShoppingNoun("aubergine, diced")).toBe("aubergine");
    expect(normalizeShoppingNoun("red onions, finely chopped")).toBe("red onion");
    expect(normalizeShoppingNoun("lemon, zest only")).toBe("lemon");
    expect(normalizeShoppingNoun("plain flour, sifted")).toBe("plain flour");

    // Distinguishing purchase forms are NOT stripped
    expect(normalizeShoppingNoun("basil, fresh")).toBe("basil, fresh");
    expect(normalizeShoppingNoun("basil, dried")).toBe("basil, dried");
  });
});

describe("lossless rational arithmetic", () => {
  it("adds fractions and integers without floating-point precision loss", () => {
    const half = parseRational("1/2");
    expect(formatRational(addRational(half, half))).toBe("1");

    const third = parseRational("1/3");
    const twoThirds = parseRational("2/3");
    expect(formatRational(addRational(third, twoThirds))).toBe("1");

    const quarter = parseRational("0.25");
    const decimalHalf = parseRational("0.5");
    expect(formatRational(addRational(quarter, decimalHalf))).toBe("0.75");
  });
});

describe("mergeShoppingItems", () => {
  it.each([
    ["1/3", "2/3", "1"],
    ["1/3", "1/3", "2/3"],
    ["1 1/3", "2/3", "2"],
    ["⅓", "⅔", "1"],
    ["1 ⅓", "⅔", "2"],
    ["- 1 1/3", "1/3", "-1"],
    ["0,1", "0,2", "0.3"],
    ["9007199254740993", "1", "9007199254740994"],
    ["9007199254740993.1", "0.1", "9007199254740993.2"],
  ])("merges exact RecipeMD quantities %s + %s", (left, right, total) => {
    const items = [makeItem("a", `*${left} tsp* salt`, "A"), makeItem("b", `*${right} tsp* salt`, "B")];
    const original = structuredClone(items);
    const [row] = mergeShoppingItems(items);
    expect(row.content).toBe(`salt ${total} tsp`);
    expect(row.memberIds).toEqual(["a", "b"]);
    expect(row.sources).toEqual(["A", "B"]);
    expect(items).toEqual(original);
  });

  it("merges transatlantic synonyms and plurals into unified rows", () => {
    const items = [
      makeItem("1", "*1* aubergine, diced", "Pie"),
      makeItem("2", "*2* eggplants, sliced", "Curry"),
    ];
    const rows = mergeShoppingItems(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("aubergine 3");
    expect(rows[0].memberIds).toEqual(["1", "2"]);
    expect(rows[0].sources).toEqual(["Pie", "Curry"]);
  });

  it("handles partial check states correctly", () => {
    const items = [
      makeItem("1", "*1* aubergine", "Pie", true),
      makeItem("2", "*1* eggplant", "Curry", false),
    ];
    const rows = mergeShoppingItems(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].checked).toBe(false);
    expect(rows[0].partial).toBe(true);
    expect(rows[0].checkedCount).toBe(1);

    const allChecked = [
      makeItem("1", "*1* aubergine", "Pie", true),
      makeItem("2", "*1* eggplant", "Curry", true),
    ];
    const allRows = mergeShoppingItems(allChecked);
    expect(allRows[0].checked).toBe(true);
    expect(allRows[0].partial).toBe(false);
  });

  it("separates canned/packaged forms from loose mass measures", () => {
    const items = [
      makeItem("1", "*2 cans* chopped tomatoes", "Stew"),
      makeItem("2", "*400 g* chopped tomatoes", "Sauce"),
    ];
    const rows = mergeShoppingItems(items);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.content)).toEqual([
      "chopped tomatoes 2 cans",
      "chopped tomatoes 400 g",
    ]);
  });

  it("combines multiple units cleanly", () => {
    const items = [
      makeItem("1", "*1/2 tsp* salt", "Pie"),
      makeItem("2", "*1/2 tsp* salt, fine", "Soup"),
      makeItem("3", "*2 g* salt", "Bread"),
      makeItem("4", "salt, to taste", "Salad"),
    ];
    const rows = mergeShoppingItems(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("salt 1 tsp + 2 g + salt, to taste");
    expect(rows[0].memberIds).toEqual(["1", "2", "3", "4"]);
  });
});

it('replaces overlapping synonyms once without duplicating descriptors', () => {
  expect(normalizeShoppingNoun('organic chinese napa cabbage')).toBe('organic chinese napa cabbage');
  expect(normalizeShoppingNoun('organic napa cabbage')).toBe('organic chinese napa cabbage');
  expect(normalizeShoppingNoun('fresh chinese napa cabbage')).toBe('fresh chinese napa cabbage');
  expect(normalizeShoppingNoun('organic napa cabbage and napa cabbage')).toBe('organic chinese napa cabbage and chinese napa cabbage');
});
