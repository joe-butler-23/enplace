import { expect, it } from 'vitest';
import * as core from './core';

it('adds moves and removes exact aisle nouns in the sole Markdown authority', () => {
  const initial = '## Fruit & vegetables\n- Asparagus\n\n## Rice, pasta & grains\n- couscous\n';
  const added = core.setAisle(initial, ' Aubergine ', 'Fruit & vegetables');
  expect(core.parseAisles(added)).toEqual(new Map([['asparagus', 'Fruit & vegetables'], ['aubergine', 'Fruit & vegetables'], ['couscous', 'Rice, pasta & grains']]));
  const moved = core.setAisle(added, 'aubergine', 'Chilled');
  expect(moved.match(/^- aubergine$/gm)).toHaveLength(1);
  expect(core.parseAisles(moved).get('aubergine')).toBe('Chilled');
  expect(core.parseAisles(core.setAisle(moved, 'aubergine', '')).has('aubergine')).toBe(false);
  expect(() => core.setAisle(initial, 'aubergine', 'invented')).toThrow('Invalid aisle');
});

it('excludes root cooking state files from recipes', () => {
  const text = '# Aisles\n\n## Ingredients\n- salt\n';
  expect(core.scanRecipes(['Plan.md', 'Shopping.md', 'Aisles.md', 'recipe.md'].map(path => ({ path, text }))).map(recipe => recipe.path)).toEqual(['recipe.md']);
});

it('treats old aisle comments as opaque text without leaking into display or canonical boxes', () => {
  const text = '## Soup\n- [xx] *1/2 tsp* salt <!-- aisle: Baking -->\n';
  expect(core.parseShopping(text)[0]).toEqual({ line: 1, heading: 'Soup', text: '*1/2 tsp* salt <!-- aisle: Baking -->', checked: true });
  expect(core.canonicalShoppingMarkdown(text)).toBe(text.replace('[xx]', '[x]'));
  expect(core.shoppingIngredient(core.parseShopping(text)[0].text)).toMatchObject({ noun: 'salt', display: '1/2 tsp salt' });
});

it('infers aisles from container and physical form signals', () => {
  // Can / tin / jar overrides dry grain or produce defaults
  expect(core.inferAisle('*1 can* chickpeas')).toBe('Tins & jars');
  expect(core.inferAisle('*400 g* tin chopped tomatoes')).toBe('Tins & jars');
  expect(core.inferAisle('*2 jars* passata')).toBe('Tins & jars');
  expect(core.inferAisle('*200 g* chickpeas')).toBe('Rice, pasta & grains');

  // Frozen signal overrides fresh produce default
  expect(core.inferAisle('*500 g* frozen peas')).toBe('Frozen');
  expect(core.inferAisle('*200 g* peas')).toBe('Fruit & vegetables');

  // Fresh vs dried herbs
  expect(core.inferAisle('*1 bunch* fresh coriander')).toBe('Fruit & vegetables');
  expect(core.inferAisle('*1 tsp* ground coriander')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('coriander')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('*2 tbsp* fresh basil')).toBe('Fruit & vegetables');
  expect(core.inferAisle('*1 tsp* dried basil')).toBe('Herbs, spices & oils');
});

it('inherits aisles from compound noun head suffixes', () => {
  // * oil / vinegar -> Herbs, spices & oils
  expect(core.inferAisle('toasted sesame oil')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('extra virgin olive oil')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('balsamic vinegar')).toBe('Herbs, spices & oils');

  // * flour / sugar / powder -> Baking
  expect(core.inferAisle('strong white bread flour')).toBe('Baking');
  expect(core.inferAisle('light brown soft sugar')).toBe('Baking');
  expect(core.inferAisle('baking powder')).toBe('Baking');
  expect(core.inferAisle('vanilla extract')).toBe('Baking');

  // * cheese / milk / cream / yogurt -> Dairy & eggs
  expect(core.inferAisle('mature cheddar cheese')).toBe('Dairy & eggs');
  expect(core.inferAisle('semi-skimmed milk')).toBe('Dairy & eggs');
  expect(core.inferAisle('double cream')).toBe('Dairy & eggs');
  expect(core.inferAisle('greek style yogurt')).toBe('Dairy & eggs');
  expect(core.inferAisle('free-range eggs')).toBe('Dairy & eggs');

  // * bread / loaf / bun / wrap -> Bakery
  expect(core.inferAisle('sourdough bread')).toBe('Bakery');
  expect(core.inferAisle('seeded burger buns')).toBe('Bakery');
  expect(core.inferAisle('corn tortillas')).toBe('Bakery');
  expect(core.inferAisle('garlic naan')).toBe('Bakery');

  // * steak / breast / mince / sausage / fillet -> Meat & fish
  expect(core.inferAisle('chicken breast')).toBe('Meat & fish');
  expect(core.inferAisle('beef rump steak')).toBe('Meat & fish');
  expect(core.inferAisle('pork sausages')).toBe('Meat & fish');
  expect(core.inferAisle('salmon fillet')).toBe('Meat & fish');
  expect(core.inferAisle('king prawns')).toBe('Meat & fish');

  // * rice / noodle / pasta / lentil / oat -> Rice, pasta & grains
  expect(core.inferAisle('basmati rice')).toBe('Rice, pasta & grains');
  expect(core.inferAisle('dried egg noodles')).toBe('Rice, pasta & grains');
  expect(core.inferAisle('red lentils')).toBe('Rice, pasta & grains');
  expect(core.inferAisle('porridge oats')).toBe('Rice, pasta & grains');

  // * sauce / paste / chutney / mustard -> Tins & jars
  expect(core.inferAisle('dark soy sauce')).toBe('Tins & jars');
  expect(core.inferAisle('tomato paste')).toBe('Tins & jars');
  expect(core.inferAisle('mango chutney')).toBe('Tins & jars');
  expect(core.inferAisle('dijon mustard')).toBe('Tins & jars');

  // * juice / tea / coffee / wine -> Drinks
  expect(core.inferAisle('freshly squeezed orange juice')).toBe('Drinks');
  expect(core.inferAisle('green tea')).toBe('Drinks');
  expect(core.inferAisle('dry white wine')).toBe('Drinks');

  // Household items
  expect(core.inferAisle('aluminium foil')).toBe('Household');
  expect(core.inferAisle('kitchen sponge')).toBe('Household');
});

it('resolves base roots and compound disambiguation correctly', () => {
  // Produce roots
  expect(core.inferAisle('aubergine')).toBe('Fruit & vegetables');
  expect(core.inferAisle('courgette')).toBe('Fruit & vegetables');
  expect(core.inferAisle('chestnut mushrooms')).toBe('Fruit & vegetables');
  expect(core.inferAisle('spring onions')).toBe('Fruit & vegetables');
  expect(core.inferAisle('baby potatoes')).toBe('Fruit & vegetables');

  // Pepper disambiguation: spice vs vegetable
  expect(core.inferAisle('bell pepper')).toBe('Fruit & vegetables');
  expect(core.inferAisle('sweet red pepper')).toBe('Fruit & vegetables');
  expect(core.inferAisle('black pepper')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('cracked black peppercorns')).toBe('Herbs, spices & oils');

  // Butter disambiguation: dairy vs nut butter
  expect(core.inferAisle('salted butter')).toBe('Dairy & eggs');
  expect(core.inferAisle('peanut butter')).toBe('Tins & jars');

  // Unknown fallback
  expect(core.inferAisle('nonexistent gadget xyz')).toBeNull();
});

it('strictly honours household preference sovereignty in resolveShoppingAisle', () => {
  const householdAisles = new Map([
    ['cheddar cheese', 'Chilled'],
    ['garlic', 'Household'],
  ]);

  // Household override wins over natural inference
  expect(core.resolveShoppingAisle('cheddar cheese', householdAisles)).toBe('Chilled');
  expect(core.resolveShoppingAisle('garlic', householdAisles)).toBe('Household');

  // Natural inference applies when household has no override
  expect(core.resolveShoppingAisle('aubergine', householdAisles)).toBe('Fruit & vegetables');
  expect(core.resolveShoppingAisle('*1 can* chickpeas', householdAisles)).toBe('Tins & jars');

  // Fallback to "Other" when neither household nor inference matches
  expect(core.resolveShoppingAisle('completely unknown item 123', householdAisles)).toBe('Other');
});

it('classifies parsed container units consistently with ingredient text', () => {
  for (const text of ['*1 can* chickpeas', '*2 tins* tomatoes', '*1 jar* cherries']) {
    expect(core.inferAisle(core.shoppingIngredient(text))).toBe('Tins & jars');
    expect(core.inferAisle(text)).toBe('Tins & jars');
  }
});

it('leaves unrecognized product heads unknown instead of matching word prefixes', () => {
  for (const text of ['butternut squash cubes', 'nutmeg whole', 'eggplant dip mix', 'coffeecake']) {
    expect(core.inferAisle(text)).toBeNull();
  }
});

it('uses compound product heads before herb and pepper modifiers', () => {
  expect(core.inferAisle('fresh basil oil')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('fresh basil butter')).toBe('Dairy & eggs');
  expect(core.inferAisle('red pepper paste')).toBe('Tins & jars');
  expect(core.inferAisle('ground black pepper sauce')).toBe('Tins & jars');
  expect(core.inferAisle('fresh coriander seeds')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('fresh basil, frozen for storage')).toBe('Fruit & vegetables');
});

it('correctly classifies widened culinary ingredients and handles alternatives', () => {
  // Nuts & seeds
  expect(core.inferAisle('toasted pine nuts')).toBe('Baking');
  expect(core.inferAisle('chopped walnuts')).toBe('Baking');
  expect(core.inferAisle('white sesame seeds')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('sunflower seeds')).toBe('Herbs, spices & oils');

  // Syrups & sweeteners
  expect(core.inferAisle('maple syrup')).toBe('Baking');
  expect(core.inferAisle('golden syrup')).toBe('Baking');
  expect(core.inferAisle('agave nectar')).toBe('Baking');

  // Pastes & condiments
  expect(core.inferAisle('white miso')).toBe('Tins & jars');
  expect(core.inferAisle('sriracha')).toBe('Tins & jars');
  expect(core.inferAisle('capers, drained')).toBe('Tins & jars');
  expect(core.inferAisle('gochujang')).toBe('Tins & jars');

  // Specialty produce & herbs
  expect(core.inferAisle('jalapeno')).toBe('Fruit & vegetables');
  expect(core.inferAisle('brussels sprouts')).toBe('Fruit & vegetables');
  expect(core.inferAisle('fresh thyme')).toBe('Fruit & vegetables');
  expect(core.inferAisle("za'atar")).toBe('Herbs, spices & oils');
  expect(core.inferAisle('cajun seasoning')).toBe('Herbs, spices & oils');
  expect(core.inferAisle('bay leaves')).toBe('Herbs, spices & oils');

  // Cheeses & Bakery
  expect(core.inferAisle('grana padano, grated')).toBe('Dairy & eggs');
  expect(core.inferAisle('panko breadcrumbs')).toBe('Bakery');
  expect(core.inferAisle('puff pastry')).toBe('Baking');

  // Alternatives & connector phrases
  expect(core.inferAisle('soy sauce or tamari')).toBe('Tins & jars');
  expect(core.inferAisle(', plus more for dusting plain flour')).toBe('Baking');
});


