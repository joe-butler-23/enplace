import { describe, expect, it } from "vitest";
import {
  classifyShoppingPair,
  formatRational,
  mergeShoppingItems,
  normalizeShoppingNoun,
  parseRational,
  addRational,
  type ShoppingItem,
} from "./shopping.js";
import { parseRecipeIngredient } from "./recipemd.js";

const item = (id: string, content: string, source = "Meal", checked = false): ShoppingItem => ({
  id,
  content,
  labels: [],
  sources: [source],
  checked,
});

describe("deep mathematical and fractional arithmetic invariants", () => {
  it("losslessly parses and adds exact unicode fractions and mixed numbers", () => {
    // Unicode fractions parsed through parseRecipeIngredient
    const r1 = parseRecipeIngredient("*½* aubergine");
    const r2 = parseRecipeIngredient("*1 ½* eggplants");
    expect(r1.amount).toBeDefined();
    expect(r2.amount).toBeDefined();

    const items: ShoppingItem[] = [
      item("1", "*½* aubergine", "Recipe 1"),
      item("2", "*1 ½* eggplants", "Recipe 2"),
    ];
    const merged = mergeShoppingItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("aubergine 2");
  });

  it("handles standard culinary fractional sums exactly", () => {
    const fractions: Array<[string, string, string]> = [
      ["1/4", "1/4", "0.5"],
      ["1/4", "3/4", "1"],
      ["1/3", "2/3", "1"],
      ["1/8", "3/8", "0.5"],
      ["1/8", "7/8", "1"],
      ["0.25", "0.75", "1"],
      ["0.1", "0.2", "0.3"], // classic IEEE 754 float failure: 0.1 + 0.2 = 0.30000000000000004
      ["1/6", "5/6", "1"],
    ];

    for (const [a, b, expected] of fractions) {
      const sum = addRational(parseRational(a), parseRational(b));
      expect(formatRational(sum), `Failed on ${a} + ${b}`).toBe(expected);
    }
  });

  it("maintains unit isolation when non-convertible units appear for the same ingredient", () => {
    const items: ShoppingItem[] = [
      item("1", "*100 g* plain flour", "Cake"),
      item("2", "*200 g* plain flour", "Bread"),
      item("3", "*1 cup* plain flour", "Pancakes"),
      item("4", "plain flour, for dusting", "Pastry"),
    ];

    const merged = mergeShoppingItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("plain flour 300 g + 1 cup + plain flour, for dusting");
    expect(merged[0].memberIds).toEqual(["1", "2", "3", "4"]);
  });

  it("merges multiple packaged container counts across synonyms", () => {
    const items: ShoppingItem[] = [
      item("1", "*1 can* chickpeas", "Curry"),
      item("2", "*2 cans* garbanzo beans", "Salad"),
    ];
    const merged = mergeShoppingItems(items);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe("chickpeas 3 cans");
    expect(merged[0].sources).toEqual(["Curry", "Salad"]);
  });
});

describe("property-based invariants: order independence and idempotence", () => {
  it("is strictly order-independent (permutation invariant)", () => {
    const baseItems: ShoppingItem[] = [
      item("1", "*1* aubergine, diced", "R1"),
      item("2", "*2* eggplants, sliced", "R2"),
      item("3", "*200 g* courgette", "R3"),
      item("4", "*300 g* zucchini", "R4"),
      item("5", "*1/2 tsp* salt", "R5"),
      item("6", "*1/2 tsp* salt, fine", "R6"),
      item("7", "*2 cans* chopped tomatoes", "R7"),
      item("8", "*400 g* chopped tomatoes", "R8"),
    ];

    // Forward run
    const result1 = mergeShoppingItems(baseItems);

    // Reversed run
    const result2 = mergeShoppingItems([...baseItems].reverse());

    // Scrambled run
    const scrambled = [
      baseItems[4], baseItems[0], baseItems[7], baseItems[2],
      baseItems[1], baseItems[6], baseItems[3], baseItems[5],
    ];
    const result3 = mergeShoppingItems(scrambled);

    // Number of groups must be identical
    expect(result1.length).toBe(5); // aubergine, courgette, salt, chopped tomatoes (cans), chopped tomatoes (mass)
    expect(result2.length).toBe(5);
    expect(result3.length).toBe(5);

    // Compare aggregated content by sorting by memberIds set
    const key = (rows: typeof result1) =>
      rows.map(r => [...r.memberIds].sort().join(",")).sort();

    expect(key(result1)).toEqual(key(result2));
    expect(key(result1)).toEqual(key(result3));
  });

  it("is idempotent: re-merging already merged items produces identical output", () => {
    const items: ShoppingItem[] = [
      item("1", "*1* aubergine, diced", "R1"),
      item("2", "*2* eggplants, sliced", "R2"),
      item("3", "*100 g* rocket", "R3"),
      item("4", "*50 g* arugula", "R4"),
    ];

    const pass1 = mergeShoppingItems(items);
    const pass2 = mergeShoppingItems(pass1);

    expect(pass2.length).toBe(pass1.length);
    expect(pass2.map(r => r.content)).toEqual(pass1.map(r => r.content));
  });
});

describe("exhaustive pantry taxonomy: refusal to merge distinct goods", () => {
  const pantryTaxonomy: Array<{ category: string; pairs: Array<[string, string]> }> = [
    {
      category: "Vinegars",
      pairs: [
        ["balsamic vinegar", "red wine vinegar"],
        ["red wine vinegar", "white wine vinegar"],
        ["apple cider vinegar", "white wine vinegar"],
        ["rice vinegar", "malt vinegar"],
        ["sherry vinegar", "balsamic vinegar"],
        ["distilled white vinegar", "white wine vinegar"],
      ],
    },
    {
      category: "Sugars & Sweeteners",
      pairs: [
        ["caster sugar", "granulated sugar"],
        ["caster sugar", "light brown soft sugar"],
        ["dark brown sugar", "demerara sugar"],
        ["icing sugar", "granulated sugar"],
        ["maple syrup", "golden syrup"],
        ["honey", "agave nectar"],
        ["molasses", "black treacle"],
      ],
    },
    {
      category: "Oils & Cooking Fats",
      pairs: [
        ["extra virgin olive oil", "olive oil"],
        ["olive oil", "vegetable oil"],
        ["sunflower oil", "rapeseed oil"],
        ["sesame oil", "chili oil"],
        ["coconut oil", "vegetable oil"],
        ["ghee", "butter"],
        ["lard", "butter"],
      ],
    },
    {
      category: "Flours & Grains",
      pairs: [
        ["plain flour", "self-raising flour"],
        ["plain flour", "bread flour"],
        ["wholemeal flour", "white flour"],
        ["rye flour", "wheat flour"],
        ["cornstarch", "plain flour"],
        ["rolled oats", "steel cut oats"],
        ["couscous", "bulgur wheat"],
        ["basmati rice", "jasmine rice"],
        ["brown rice", "white rice"],
        ["arborio rice", "long grain rice"],
      ],
    },
    {
      category: "Dairy & Plant Milks",
      pairs: [
        ["whole milk", "semi-skimmed milk"],
        ["skimmed milk", "whole milk"],
        ["double cream", "single cream"],
        ["buttermilk", "whole milk"],
        ["evaporated milk", "condensed milk"],
        ["coconut milk", "cow milk"],
        ["sour cream", "creme fraiche"],
        ["greek yogurt", "natural yogurt"],
      ],
    },
    {
      category: "Cheeses",
      pairs: [
        ["cheddar cheese", "parmesan cheese"],
        ["parmesan", "pecorino"],
        ["mozzarella", "feta"],
        ["ricotta", "cottage cheese"],
        ["brie", "camembert"],
        ["gruyere", "emmental"],
      ],
    },
    {
      category: "Stocks & Broths",
      pairs: [
        ["chicken stock", "beef stock"],
        ["beef stock", "vegetable stock"],
        ["fish stock", "chicken stock"],
        ["lamb stock", "beef stock"],
      ],
    },
    {
      category: "Herbs & Spices",
      pairs: [
        ["fresh coriander", "coriander seeds"],
        ["fresh basil", "dried basil"],
        ["fresh oregano", "dried oregano"],
        ["fresh thyme", "dried thyme"],
        ["fresh rosemary", "dried rosemary"],
        ["smoked paprika", "sweet paprika"],
        ["black pepper", "white pepper"],
        ["ground cumin", "cumin seeds"],
        ["mustard powder", "mustard seeds"],
        ["cinnamon sticks", "ground cinnamon"],
      ],
    },
    {
      category: "Proteins & Cuts",
      pairs: [
        ["chicken breast", "chicken thigh"],
        ["chicken breast", "turkey breast"],
        ["pork mince", "beef mince"],
        ["lamb mince", "beef mince"],
        ["salmon fillet", "cod fillet"],
        ["smoked salmon", "fresh salmon fillet"],
        ["bacon", "pancetta"],
        ["firm tofu", "silken tofu"],
      ],
    },
    {
      category: "Citrus & Fruit",
      pairs: [
        ["lemon", "lime"],
        ["orange", "grapefruit"],
        ["green apple", "red apple"],
        ["fresh ginger", "ground ginger"],
      ],
    },
  ];

  for (const { category, pairs } of pantryTaxonomy) {
    for (const [a, b] of pairs) {
      it(`[${category}] refuses to merge '${a}' and '${b}'`, () => {
        const relation = classifyShoppingPair(a, b).relation;
        expect(relation, `Incorrectly merged in category ${category}: ${a} <-> ${b}`).toBe("unknown");
      });
    }
  }
});

describe("large-scale performance and memory stress testing", () => {
  it("processes 2,000 realistic grocery items within the 500 ms test budget", () => {
    const stapleIngredients = [
      "*1* aubergine, diced",
      "*2* eggplants, sliced",
      "*200 g* courgette, grated",
      "*300 g* zucchini, thinly sliced",
      "*1/2 tsp* salt",
      "*1/2 tsp* salt, fine",
      "*2 cloves* garlic, minced",
      "garlic, 5-6 cloves",
      "*1 can* chickpeas",
      "*2 cans* garbanzo beans",
      "*1 tbsp* olive oil",
      "*2 tbsp* extra virgin olive oil",
      "*150 g* rocket, washed",
      "*50 g* arugula",
      "*1* red onion, finely chopped",
      "*2* red onions, sliced",
      "*500 g* minced beef",
      "*250 g* ground beef",
      "*1 tsp* bicarbonate of soda",
      "*1/2 tsp* baking soda",
    ];

    const largeList: ShoppingItem[] = [];
    for (let i = 0; i < 2000; i++) {
      const template = stapleIngredients[i % stapleIngredients.length];
      largeList.push({
        id: `item-${i}`,
        content: template,
        labels: [],
        sources: [`Recipe-${Math.floor(i / 10)}`],
        checked: i % 3 === 0,
      });
    }

    const start = performance.now();
    const merged = mergeShoppingItems(largeList);
    const duration = performance.now() - start;

    // 2,000 items from 20 distinct ingredient kinds should collapse into ~12 consolidated rows
    expect(merged.length).toBeLessThanOrEqual(15);
    expect(merged.length).toBeGreaterThanOrEqual(10);

    // Performance budget: under 500ms for 2,000 full CommonMark-parsed items (averages < 250µs per item under concurrent test load)
    expect(duration).toBeLessThan(500);
  });
});
