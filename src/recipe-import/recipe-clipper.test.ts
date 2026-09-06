// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { clipRecipes } from "./recipe-clipper";

function alignedRecipe(serialized: string[], visible: string[]) {
  const data = { "@type": "Recipe", "@id": "https://example.test/soup#recipe", name: "Onion soup",
    recipeIngredient: serialized, recipeInstructions: ["Cook the onions."] };
  const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>
    <article id="recipe" class="wprm-recipe-container"><h1>Onion soup</h1><h2>Ingredients</h2>
    <ul>${visible.map(row => `<li>${row}</li>`).join("")}</ul><h2>Method</h2><p>Cook the onions.</p></article>`;
  return clipRecipes(new DOMParser().parseFromString(html, "text/html"), { url: "https://example.test/soup" })[0];
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
    const found = clipRecipes(new DOMParser().parseFromString(html, "text/html"), { url: "https://example.test/page" });
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
    const [found] = clipRecipes(new DOMParser().parseFromString(html, "text/html"), { url: "https://example.test/soup" });
    expect(found.ingredients).toEqual(["2 carrots", "1 tsp cumin", "500 ml stock"]);
    expect(found.instructions).toEqual(["Chop the carrots.", "Simmer for 15 minutes."]);
  });
});
