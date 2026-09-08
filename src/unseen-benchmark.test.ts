import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseRecipe, mergeShoppingItems, type ShoppingItem } from "./core.js";
import { classifyShoppingPair, normalizeShoppingNoun } from "./shopping.js";

describe("unseen recipe combinations from real sample pack", () => {
  it("deduplicates ingredients across all 11 real sample pack recipes without corruption", () => {
    const dir = join(process.cwd(), "sample/recipes");
    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(10);

    const allIngredients: Array<{ recipe: string; text: string }> = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      const parsed = parseRecipe(file, text);
      if (parsed) {
        for (const ing of parsed.ingredients) {
          allIngredients.push({ recipe: parsed.title, text: ing });
        }
      }
    }

    const items: ShoppingItem[] = allIngredients.map((ing, i) => ({
      id: `item-${i}`,
      content: ing.text,
      labels: [],
      sources: [ing.recipe],
      checked: false,
    }));

    const merged = mergeShoppingItems(items);

    // Should compress redundant items across the week's plan
    expect(merged.length).toBeLessThan(items.length);

    // Multi-source merged items
    const shared = merged.filter(r => (r.sources?.length ?? 0) > 1);
    expect(shared.length).toBeGreaterThan(0);

    // Olive oil appears across multiple recipes:
    const oliveOil = merged.find(r => normalizeShoppingNoun(r.content).includes("olive oil"));
    expect(oliveOil).toBeDefined();
    expect(oliveOil!.sources!.length).toBeGreaterThan(1);
    expect(oliveOil!.memberIds.length).toBeGreaterThan(1);

    // Onions appear across multiple recipes with differing prep:
    // e.g. "1 onion, diced", "1 red onion, sliced"
    // Red onion should NOT merge into standard brown onion:
    const redOnions = merged.filter(r => r.content.toLowerCase().includes("red onion"));
    const brownOnions = merged.filter(r => r.content.toLowerCase().includes("onion") && !r.content.toLowerCase().includes("red onion") && !r.content.toLowerCase().includes("spring"));
    
    // They must remain distinct
    for (const ro of redOnions) {
      for (const bo of brownOnions) {
        expect(ro.content).not.toBe(bo.content);
      }
    }
  });
});

describe("heldout adversarial tests: strict non-merge invariants", () => {
  const unsafePairs: Array<[string, string, string]> = [
    // [left, right, reason]
    ["white onion", "red onion", "color / flavor profile"],
    ["fresh coriander", "coriander seeds", "herb leaf vs spice seed"],
    ["whole milk", "skimmed milk", "fat content"],
    ["semi-skimmed milk", "whole milk", "fat content"],
    ["black beans", "black bean sauce", "whole pulse vs condiment sauce"],
    ["rice noodles", "egg noodles", "grain / allergen profile"],
    ["sweet potato", "baking potato", "botanical / flavor difference"],
    ["baby spinach", "frozen spinach", "fresh loose vs preserved brick"],
    ["plain flour", "self-raising flour", "raising agent presence"],
    ["plain flour", "bread flour", "gluten / protein content"],
    ["smoked paprika", "sweet paprika", "smoked flavor profile"],
    ["chicken thighs", "chicken breasts", "meat cut / fat profile"],
    ["dark soy sauce", "light soy sauce", "salinity / coloring strength"],
    ["salted butter", "unsalted butter", "salt content"],
    ["apple cider vinegar", "malt vinegar", "acid base"],
    ["double cream", "single cream", "fat percentage"],
    ["green lentils", "red split lentils", "cooking time / texture"],
    ["basil, fresh", "basil, dried", "purchase form"],
    ["parsley, fresh", "parsley, dried", "purchase form"],
    ["salmon fillets", "smoked salmon", "cured / ready-to-eat vs raw cut"],
    ["tinned tuna in oil", "tinned tuna in spring water", "canning medium"],
    ["garlic powder", "garlic cloves", "powdered spice vs fresh bulb"],
    ["curry powder", "curry paste", "dry blend vs wet paste"],
  ];

  for (const [a, b, reason] of unsafePairs) {
    it(`refuses to merge '${a}' and '${b}' (${reason})`, () => {
      const relation = classifyShoppingPair(a, b).relation;
      expect(relation, `Failed on: ${a} vs ${b}`).not.toBe("same");
    });
  }
});

describe("heldout synonym and inflection tests", () => {
  const synonymPairs: Array<[string, string]> = [
    ["aubergine", "eggplant"],
    ["aubergines", "eggplants"],
    ["courgette", "zucchini"],
    ["courgettes", "zucchinis"],
    ["rocket", "arugula"],
    ["pak choi", "bok choy"],
    ["spring onions", "scallions"],
    ["spring onion", "scallion"],
    ["swede", "rutabaga"],
    ["broad beans", "fava beans"],
    ["cannellini beans", "white kidney beans"],
    ["chickpeas", "garbanzo beans"],
    ["icing sugar", "powdered sugar"],
    ["caster sugar", "superfine sugar"],
    ["minced beef", "ground beef"],
    ["minced pork", "ground pork"],
    ["plain yogurt", "plain yoghurt"],
    ["cornstarch", "corn starch"],
  ];

  for (const [a, b] of synonymPairs) {
    it(`correctly identifies '${a}' and '${b}' as same purchase item`, () => {
      const relation = classifyShoppingPair(a, b).relation;
      expect(relation, `Failed on: ${a} vs ${b}`).toBe("same");
    });
  }
});

describe("heldout whole shopping list deduplication scenarios", () => {
  it("deduplicates transatlantic synonym ingredients with different preparations and quantities", () => {
    const list: ShoppingItem[] = [
      { id: "1", content: "*1* aubergine, diced", labels: [], sources: ["Ratatouille"], checked: false },
      { id: "2", content: "*2* eggplants, thinly sliced", labels: [], sources: ["Moussaka"], checked: false },
      { id: "3", content: "*150 g* rocket, washed", labels: [], sources: ["Salad"], checked: true },
      { id: "4", content: "*50 g* arugula", labels: [], sources: ["Pizza"], checked: false },
    ];

    const merged = mergeShoppingItems(list);
    expect(merged).toHaveLength(2);

    const aubergineRow = merged.find(r => r.content.startsWith("aubergine"));
    expect(aubergineRow).toBeDefined();
    expect(aubergineRow!.content).toBe("aubergine 3");
    expect(aubergineRow!.sources).toEqual(["Ratatouille", "Moussaka"]);

    const rocketRow = merged.find(r => r.content.startsWith("rocket"));
    expect(rocketRow).toBeDefined();
    expect(rocketRow!.content).toBe("rocket 200 g");
    expect(rocketRow!.sources).toEqual(["Salad", "Pizza"]);
    expect(rocketRow!.partial).toBe(true); // 1 checked, 1 unchecked
  });
});
