import { describe, expect, it } from 'vitest';
import { buildShoppingMarkdown, parseRecipe, shoppingPlainText } from './core';
import { groupShoppingItems } from './views/components/ShoppingListView';

const item = (id: string, content: string, source: string, checked = false) => ({ id, content, sources: [source], labels: [], checked });

describe('shopping nouns', () => {
  it('preserves raw RecipeMD amounts and names in each recipe block', () => {
    const ingredients = ['*1/2 tsp* salt, fine', '_½ tbsp_ olive oil', '*1 1/2* aubergine, diced'];
    const recipe = parseRecipe('soup.md', `# Soup\n\n---\n\n${ingredients.map(text => `- ${text}`).join('\n')}\n\n---\n\nCook.\n`)!;
    expect(recipe.ingredients).toEqual(ingredients);
    const built = buildShoppingMarkdown('', [recipe], [recipe]);
    expect(built).toBe(`## Soup\n${ingredients.map(text => `- [ ] ${text}`).join('\n')}\n`);
    expect(buildShoppingMarkdown(built.replace('[ ]', '[x]'), [recipe], [recipe])).toContain('- [x] *1/2 tsp* salt, fine');
    expect(shoppingPlainText(built)).toBe('## Soup\n1/2 tsp salt, fine\n½ tbsp olive oil\n1 1/2 aubergine, diced\n');
  });

  it('merges exact nouns and compatible quantities while retaining all members and sources', () => {
    const items = [item('1', '*1* Aubergine, diced', 'Pie', true), item('2', '*1* aubergine, sliced', 'Soup'),
      item('3', '*1/2 tsp* salt', 'Pie'), item('4', '*1/2 tsp* salt, fine', 'Soup'),
      item('5', '*2 g* salt', 'Bread'), item('6', 'salt, to taste', 'Salad')];
    for (const grouping of ['none', 'section'] as const) {
      const rows = groupShoppingItems(items, grouping).flatMap(group => group.items);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ content: 'Aubergine 2', checked: false, memberIds: ['1', '2'], sources: ['Pie', 'Soup'] });
      expect(rows[1]).toMatchObject({ content: 'salt 1 tsp + 2 g + salt, to taste', memberIds: ['3', '4', '5', '6'] });
    }
    const recipeRows = groupShoppingItems(items, 'recipe').flatMap(group => group.items);
    expect(recipeRows).toHaveLength(6);
    expect(recipeRows[0]).toMatchObject({ content: '1 Aubergine, diced', checked: true });
  });

  it('keeps plural spellings and manual prose exact without guessing amounts', () => {
    const items = [item('1', '*100 g* couscous', 'One'), item('2', '*200 g* asparagus', 'One'),
      item('3', '*1* tomato', 'Two'), item('4', '*2* tomatoes', 'Two'),
      item('5', '2 eggs', 'Other'), item('6', 'eggs', 'Other')];
    const rows = groupShoppingItems(items, 'none')[0].items;
    expect(rows.map(row => row.content)).toEqual(['couscous 100 g', 'asparagus 200 g', 'tomato 1', 'tomatoes 2', '2 eggs', 'eggs']);
    expect(groupShoppingItems([item('1', '*1* aubergine', 'One', true), item('2', '*1* aubergine', 'Two', true)], 'none')[0].items[0].checked).toBe(true);
  });
});

it('retains unquantified range text and first-seen noun spelling without interpreting prose', () => {
  const range = item('range', 'garlic, 5-6 cloves', 'Soup');
  const alone = groupShoppingItems([range], 'none')[0].items[0];
  expect(alone.content).toBe('garlic, 5-6 cloves');
  const mixed = groupShoppingItems([item('amount', '*2 cloves* Garlic, minced', 'Pie'), range, item('range2', 'garlic, 1-2 heads', 'Stew')], 'none')[0].items[0];
  expect(mixed.content).toBe('Garlic 2 cloves + garlic, 5-6 cloves + garlic, 1-2 heads');
  expect(mixed.memberIds).toEqual(['amount', 'range', 'range2']);
  expect(groupShoppingItems([item('1', '*1* Aubergine, sliced', 'Pie'), item('2', '*1* aubergine, diced', 'Soup')], 'none')[0].items[0].content).toBe('Aubergine 2');
});
