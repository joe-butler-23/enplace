import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildShoppingMarkdown, parseRecipe, parseShopping, mergeShoppingItems, resolveShoppingAisle } from './core';

type Ingredient = { text: string; purchase: string; aisle: string; include: boolean; ambiguity?: string };
const corpus: { recipes: { title: string; ingredients: Ingredient[] }[] } = JSON.parse(readFileSync(new URL('../tests/fixtures/shopping/published.json', import.meta.url), 'utf8'));
// Known unsupported structures stay visible as Other; these are not accuracy passes.
const unsupported = new Set([
  '*¼ teaspoon* red chilli (hot pepper) powder',
  'Extra-virgin or virgin olive oil',
  'Fresh, coarsely-cut coriander leaves',
  '1 minced jalapeño OR 2 minced serrano chiles OR 2 tablespoon minced of any chile pepper like (adjust for spiciness)',
  'Chocolate, caramel, or butterscotch sauce',
  '225–500 g (½–1 pound) guanciale or pancetta',
]);
for (const { title, ingredients } of corpus.recipes) {
  it(`${title}: preserves every published requirement through planning and rebuild`, () => {
    const recipe = parseRecipe('published.md', `# ${title}\n\n---\n\n${ingredients.map(x => `- ${x.text}`).join('\n')}\n\n---\n\nCook.\n`)!;
    const original = structuredClone(recipe);
    const markdown = buildShoppingMarkdown('', [recipe], [recipe]);
    expect(parseShopping(markdown).map(x => x.text)).toEqual(ingredients.filter(x => x.include).map(x => x.text));
    expect(buildShoppingMarkdown(markdown, [recipe], [recipe])).toBe(markdown);
    expect(recipe).toEqual(original);
    const items = parseShopping(markdown).map((x, i) => ({ id: String(i), content: x.text, checked: false, labels: [] }));
    expect(mergeShoppingItems(items).flatMap(x => x.memberIds).sort()).toEqual(items.map(x => x.id).sort());
  });
  for (const item of ingredients.filter(x => x.include && !x.ambiguity)) {
    it(`${title}: ${unsupported.has(item.text) ? 'retains unsupported wording in Other' : 'assigns expected aisle'}: ${item.text}`, () => {
      expect(resolveShoppingAisle(item.text)).toBe(unsupported.has(item.text) ? 'Other' : item.aisle);
    });
  }
}

it('combining published recipes never merges independently labelled distinct products', () => {
  const inputs = corpus.recipes.flatMap(recipe => recipe.ingredients).filter(x => x.include);
  const items = inputs.map((item, i) => ({ id: String(i), content: item.text, labels: [], checked: false }));
  for (const group of mergeShoppingItems(items)) {
    expect(new Set(group.memberIds.map(id => inputs[Number(id)].purchase.toLowerCase())).size, group.content).toBe(1);
  }
});
