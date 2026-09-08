import { expect, it } from 'vitest';
import { buildShoppingMarkdown, parseRecipe, parseShopping, shoppingIngredient, resolveShoppingAisle, mergeShoppingItems } from './core';

const recipe = (title: string, ingredients: string[]) => parseRecipe(`${title}.md`, `# ${title}\n\n---\n\n${ingredients.map(x => `- ${x}`).join('\n')}\n\n---\n\nCook.\n`)!;

it('builds a usable non-AI list from three preparation-heavy recipes without changing sources', () => {
  const recipes = [
    recipe('Cold soup', ['*2* (about 300 g) green or red peppers, seeded and cut into rough 2 cm chunks', '*2* cloves garlic, peeled and smashed', '*90 ml* extra-virgin olive oil, plus more for serving', '*1 tsp* kosher salt, plus more to taste', '*80 g* white sandwich, french, or italian bread, crusts removed, torn into pieces']),
    recipe('Herb soup', ['*1* garlic clove peeled and bashed', '*30 ml* olive oil', 'fine sea salt', '*1* lime zest finely grated, to get 1 tsp, and juiced', '*10 g* fresh dill leaves', '*40 g* crustless bread torn into small pieces', '*80 g* ice cubes']),
    recipe('Flatbread', ['*180 ml* water, warmed to 40 °c', '*10 ml* (2 tsp), plus more for oiling extra-virgin olive oil', '*12 g* granulated sugar', '*250 g* , plus more for dusting plain flour', '*2 g* salt']),
  ];
  const original = structuredClone(recipes);
  const markdown = buildShoppingMarkdown('- [ ] water\n', recipes, recipes);
  const items = parseShopping(markdown).map((item, i) => ({ id: String(i), content: item.text, checked: item.checked, sources: item.heading ? [item.heading] : [], labels: [], aisle: resolveShoppingAisle(shoppingIngredient(item.text)) }));
  const rows = mergeShoppingItems(items);
  expect(rows.map(row => [row.content, row.aisle])).toEqual([
    ['water', 'Drinks'],
    ['2 green or red peppers', 'Fruit & vegetables'],
    ['3 cloves garlic', 'Fruit & vegetables'],
    ['130 ml olive oil', 'Herbs, spices & oils'],
    ['≈8 g salt', 'Herbs, spices & oils'],
    ['80 g white sandwich, french, or italian bread', 'Bakery'],
    ['1 lime', 'Fruit & vegetables'],
    ['10 g fresh dill leaves', 'Fruit & vegetables'],
    ['40 g crustless bread', 'Bakery'],
    ['12 g granulated sugar', 'Baking'],
    ['250 g plain flour', 'Baking'],
  ]);
  expect(rows.find(row => row.content === '130 ml olive oil')?.memberIds).toHaveLength(3);
  expect(markdown).not.toContain('*80 g* ice cubes');
  expect(markdown).not.toContain('*180 ml* water');
  expect(markdown).toContain('*250 g* , plus more for dusting plain flour');
  expect(recipes).toEqual(original);
});

it('retains purchased waters, flavoured products, forms and incompatible count units', () => {
  const names = ['rose water', 'coconut water', 'bottled water', 'sparkling water', 'ice cream', 'garlic olive oil', 'olive oil', 'celery salt', 'salt', 'curing salt', 'fresh basil', 'dried basil', 'whole cloves', 'ground cloves'];
  const r = recipe('Forms', names);
  expect(parseShopping(buildShoppingMarkdown('', [r], [r])).map(x => x.text)).toEqual(names);
  expect(mergeShoppingItems(names.map((content, i) => ({ id: String(i), content, labels: [], checked: false })))).toHaveLength(names.length);
  const rows = mergeShoppingItems(['*1* head garlic', '*2* garlic cloves'].map((content, i) => ({ id: String(i), content, labels: [], checked: false })));
  expect(rows[0].content).toBe('1 heads + 2 cloves garlic');
});


it('keeps unknown qualifiers, package forms and alternatives distinct', () => {
  const contents = ['*1 tsp* kosher salt', '*1 tsp* fine sea salt', '*1 g* cheese (50% fat)', '*1 g* cheese (10% fat)', '*1* garlic, peeled, powder', '*1* garlic', '*1* tomato, chopped or tinned'];
  const rows = mergeShoppingItems(contents.map((content, i) => ({ id: String(i), content, labels: [], checked: false })));
  expect(rows).toHaveLength(6);
  expect(rows[0].content).toBe('2 tsp salt');
  expect(rows[4].content).toBe('1 garlic');
  expect(rows[5].content).toBe('1 tomato, chopped or tinned');
});

it.each(['finely minced chives', 'roughly chopped walnuts', 'thinly sliced bread'])('keeps the product after a leading preparation in %s', name => {
  expect(shoppingIngredient(`*10 g* ${name}`).name).toBe(name);
  expect(resolveShoppingAisle(shoppingIngredient(`*10 g* ${name}`))).not.toBe('Other');
});


it('separates fractional preparation clauses from the vegetable, and salt grade from preparation', () => {
  const pepper = shoppingIngredient('*1* red chilli (12g), stem removed, ¼ roughly chopped, the rest finely diced');
  expect(pepper.name).toBe('red chilli');
  expect(resolveShoppingAisle(pepper)).toBe('Fruit & vegetables');
  const rows = mergeShoppingItems(['*1 tsp* salt', '*1 tsp* salt, fine'].map((content, i) => ({ id: String(i), content, labels: [], checked: false })));
  expect(rows[0].content).toBe('2 tsp salt');
});

it.each([
  [['*1.5 tsp* kosher salt', '*3 g* salt', 'fine sea salt'], '≈12 g salt'],
  [['*1 tsp* kosher salt', '*2 tsp* fine sea salt'], '3 tsp salt'],
  [['*1 tbsp* salt', '*2 tsp* sea salt'], '5 tsp salt'],
  [['*0.01 kg* salt', '*3 g* kosher salt'], '13 g salt'],
  [['*1 tbsp* salt', '*3 g* sea salt'], '≈21 g salt'],
  [['*1/3 tsp* salt', '*1 g* salt'], '≈3 g salt'],
  [['*1 TSP* salt', '*2 tsp* salt'], '3 tsp salt'],
  [['salt to taste', 'fine sea salt'], 'salt'],
  [['*2 g* salt', 'salt to taste'], '2 g salt'],
  [['*1 pinch* salt', '*2 g* salt'], 'salt'],
  [['*1 constructor* salt', '*2 g* salt'], 'salt'],
  [['*1 toString* salt', '*2 g* salt'], 'salt'],
])('renders one salt purchase total for %j', (contents, expected) => {
  for (const ordered of [contents, [...contents].reverse()]) {
    const items = ordered.map((content, i) => ({ id: String(i), content, labels: [], checked: i === 0 }));
    const original = structuredClone(items);
    const rows = mergeShoppingItems(items);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: expected, partial: true, checkedCount: 1 });
    expect(rows[0].memberIds).toHaveLength(contents.length);
    expect(items).toEqual(original);
  }
});
