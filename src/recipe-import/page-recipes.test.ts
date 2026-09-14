// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePageRecipes } from "./page-recipes";

function alignedRecipe(serialized: string[], visible: string[]) {
  const data = { "@type": "Recipe", "@id": "https://example.test/soup#recipe", name: "Onion soup",
    recipeIngredient: serialized, recipeInstructions: ["Cook the onions."] };
  const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>
    <article id="recipe" class="wprm-recipe-container"><h1>Onion soup</h1><h2>Ingredients</h2>
    <ul>${visible.map(row => `<li>${row}</li>`).join("")}</ul><h2>Method</h2><p>Cook the onions.</p></article>`;
  return parsePageRecipes(new DOMParser().parseFromString(html, "text/html"), { url: "https://example.test/soup" })[0];
}

describe("visible ingredient numeral fidelity", () => {
  it.each([
    ["2.0 onions, 400 g", "400 g onions, 2"],
    ["2.0 cups milk and 1 cup water", "1 cup milk and 2.0 cups water"],
  ])("does not transplant reordered numbers into %s", (serialized, visible) => {
    const actual = alignedRecipe([serialized, "1.0 tbsp oil"], [visible, "1 tbsp oil"]);
    expect(actual.ingredients).toEqual([serialized, "1 tbsp oil"]);
  });
  it("preserves precise amounts instead of rounding them into the same row identity", () => {
    const actual = alignedRecipe(["1.001 g spice", "2.0 onions"], ["1.004 g spice", "2 onions"]);
    expect(actual.ingredients).toEqual(["1.001 g spice", "2.0 onions"]);
  });
  it("still adopts source typography when corresponding numeral values and order agree", () => {
    const actual = alignedRecipe(["2.0 onions, 400.0g", "0.5 tbsp oil"], ["2 onions, 400g", "½ tbsp oil"]);
    expect(actual.ingredients).toEqual(["2 onions, 400g", "½ tbsp oil"]);
  });
});


describe("recipe field ownership", () => {
  it.each([
    ["Compact mixer", ["2 kg weight", "3 litre capacity", "400 W power"], "Order now for free delivery."],
    ["Shopping list", ["1 bag flour", "2 bottles milk", "3 onions"], "Pick these up on your way home."],
  ])("does not turn %s and nearby prose into a complete recipe", (title, rows, prose) => {
    const html = `<article><h1>${title}</h1><ul>${rows.map(row => `<li>${row}</li>`).join("")}</ul><p>${prose}</p></article>`;
    const found = parsePageRecipes(new DOMParser().parseFromString(html, "text/html"), { url: "https://example.test/page" });
    // Partial inference remains allowed; absence of a method must remain explicit.
    expect(found.every(recipe => recipe.instructions.length === 0 && recipe.missing.includes("instructions"))).toBe(true);
  });
  it("fills blank schema from its card without replacing cooking steps with notes or nutrition", () => {
    const data = { "@type": "Recipe", "@id": "#soup", name: "Carrot soup", recipeIngredient: [" ", null, []], recipeInstructions: " \n " };
    const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>
      <article class="wprm-recipe-container" id="soup"><h2 class="wprm-recipe-name">Carrot soup</h2>
      <ul class="wprm-recipe-ingredients"><li>2 carrots</li><li>1 tsp cumin</li><li>500 ml stock</li></ul>
      <ol class="wprm-recipe-instructions"><li>Chop the carrots.</li><li>Simmer for 15 minutes.</li></ol>
      <p class="wprm-recipe-notes">Freeze leftovers.</p><p class="wprm-nutrition-label-container">120 kcal</p></article>`;
    const [found] = parsePageRecipes(new DOMParser().parseFromString(html, "text/html"), { url: "https://example.test/soup" });
    expect(found.ingredients).toEqual(["2 carrots", "1 tsp cumin", "500 ml stock"]);
    expect(found.instructions).toEqual(["Chop the carrots.", "Simmer for 15 minutes."]);
  });
});


describe("page field boundaries", () => {
  it("does not read an ARIA-described interactive region as Brindisa recipe ingredients", () => {
    const html = readFileSync("tests/fixtures/page-recipes/brindisa-bean-salad.html", "utf8");
    const document = new DOMParser().parseFromString(html.replace(/<(?:link|style)\b[^>]*>(?:[^<]*<\/style>)?/gi, ""), "text/html");
    const [recipe] = parsePageRecipes(document, {
      url: "https://brindisa.com/blogs/spanish-food-recipes/bean-salad-with-anchoiade-and-sauce-vierge",
    });
    expect(recipe.ingredients).toEqual([
      "[Brindisa products]",
      "400g Tolosana Round Beans, soaked in cold water overnight",
      "Arbequina Extra Virgin Olive Oil",
      "Sea salt",
      "1 tin Ortiz anchovies",
      "[Other products]",
      "Forum Cabernet Sauvignon Vinegar",
      "[For the anchoïade]",
      "12 anchovy fillets",
      "2 cloves garlic, finely chopped",
      "4 tbsp extra virgin olive oil",
      "[For the sauce vierge]",
      "1/2 banana shallot, finely diced",
      "1 small clove garlic, very finely diced",
      "4 medium tomatoes, blanched, skins removed and finely diced (see note)",
      "4 tbsp red wine vinegar",
      "1 tbsp extra virgin olive oil",
      "1/2 tbsp finely chopped parsley",
      "Salt and black pepper",
    ]);
  });

  it("does not discard an ordinary component heading before its ingredient rows", () => {
    const html = `<article><h1>Soup</h1><h2>Ingredients</h2><h3>Dressing</h3><ul><li>1 lemon</li><li>2 tbsp oil</li></ul><h2>Method</h2><ol><li>Mix.</li><li>Serve.</li></ol></article>`;
    const [recipe] = parsePageRecipes(new DOMParser().parseFromString(html, "text/html"));
    expect(recipe.ingredients).toEqual(["[Dressing]", "1 lemon", "2 tbsp oil"]);
  });
});
