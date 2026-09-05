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
