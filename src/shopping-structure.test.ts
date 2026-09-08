import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { shoppingIngredient, resolveShoppingAisle, mergeShoppingItems } from './shopping';

const items = (texts: string[]) => texts.map((content, i) => ({ id: String(i), content, labels: [], checked: false }));
const products = [['courgettes', 'Fruit & vegetables'], ['carrots', 'Fruit & vegetables'], ['Cheddar', 'Dairy & eggs'], ['firm tofu', 'Chilled']] as const;
const preparations = ['roughly chopped', 'cut lengthways into strips', 'split in half', '2 cut into cubes and 3 left whole', 'left whole'];
for (const [product, aisle] of products) for (const preparation of preparations) {
  for (const text of [`${product}, ${preparation}`, `${product} , ${preparation}`, `${product} (${preparation})`, `${product} (${preparation}`]) {
    it(`separates product from annotation: ${text}`, () => {
      const rows = mergeShoppingItems(items([`*10 g* ${product}`, `*20 g* ${text}`]));
      expect(resolveShoppingAisle(shoppingIngredient(text))).toBe(aisle);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe(`30 g ${product}`);
    });
  }
}
it.each(products)('optional annotation preserves %s', (product, aisle) => {
  expect(shoppingIngredient(`${product} (optional)`).noun).toBe(shoppingIngredient(product).noun);
  expect(resolveShoppingAisle(`${product}, optional`)).toBe(aisle);
});
it.each([
  ['*3 stems* fresh curry leaves (about 30 leaves)', 'Fruit & vegetables'],
  ['*2* ears of corn (shucked)', 'Fruit & vegetables'],
  ['*2 tbsp* plus 2 tsp coconut oil, unmelted', 'Herbs, spices & oils'],
  ['*200 g* pasta shells (conchiglie)', 'Rice, pasta & grains'],
  ['sunflower oil (or rapeseed oil)', 'Herbs, spices & oils'],
  ['vegetable stock (or water)', 'Other'],
  ['cheese (10% fat)', 'Dairy & eggs'],
  ['spinach (frozen)', 'Frozen'],
  ['spinach (chopped, frozen)', 'Frozen'],
  ['spinach (frozen, chopped)', 'Frozen'],
  ['chicken (frozen tofu)', 'Other'],
  ['tomatoes (chopped and canned)', 'Tins & jars'],
  ['spinach (not frozen)', 'Other'],
  ['chickpeas (canned)', 'Tins & jars'],
  ['milk (coconut)', 'Tins & jars'],
  ['chicken (alternatively tofu)', 'Other'],
  ['chicken (tofu)', 'Other'],
  ['peas (split)', 'Rice, pasta & grains'],
])('assigns a product aisle while respecting alternatives: %s', (text, aisle) => {
  expect(resolveShoppingAisle(shoppingIngredient(text))).toBe(aisle);
});
it.each([
  ['*2 tbsp* plus 2 tsp coconut oil, unmelted', '8 tsp coconut oil'],
  ['*2 tbsp plus 2 tsp* coconut oil', '8 tsp coconut oil'],
  ['*1 kg* plus 100 g plain flour', '1100 g plain flour'],
  ['*30 g* dried breadcrumbs, plus another 10 g for the topping', '40 g dried breadcrumbs'],
])('conserves compound quantities: %s', (text, expected) => {
  expect(mergeShoppingItems(items([text]))[0].content).toBe(expected);
});
it.each([
  ['cheese (10% fat)', 'cheese (50% fat)'],
  ['peas (split)', 'peas'],
  ['garlic (chopped, powder)', 'garlic'],
  ['tomatoes (chopped and dried)', 'tomatoes'],
  ['flour (self-raising)', 'flour'],
  ['tomatoes, chopped or tinned', 'tomatoes'],
  ['oil (or butter)', 'oil'],
  ['pasta shells (wholemeal)', 'pasta shells'],
])('keeps purchase distinctions: %s and %s', (left, right) => {
  expect(mergeShoppingItems(items([left, right]))).toHaveLength(2);
});

const independent: Array<{ text: string; aisle: string; purchase: string }> = JSON.parse(readFileSync(new URL('../tests/fixtures/shopping/structure.json', import.meta.url), 'utf8'));
it.each(independent)('independent structure case: $text', ({ text, aisle }) => {
  expect(resolveShoppingAisle(shoppingIngredient(text))).toBe(aisle);
});
it('does not merge independently labelled distinct products', () => {
  const rows = mergeShoppingItems(items(independent.map(x => x.text)));
  for (const row of rows) expect(new Set(row.memberIds.map(id => independent[Number(id)].purchase)).size).toBe(1);
});
