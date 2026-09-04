import { expect, it } from 'vitest';
import { buildShoppingMarkdown, parseRecipe, parseShopping, resetShopping, setShoppingAisle, shoppingPlainText, toggleShoppingItem } from './core';
import { groupShoppingItems } from './views/components/ShoppingListView';
it('keeps aisle independent of recipe and retains it across ticks and rebuilds', () => {
  const original = '## Soup\n- [ ] tomatoes\n- [x] salt\n\n## Notes\nBring bags.\n';
  const assigned = setShoppingAisle(original, 1, 'tomatoes', 'Fruit & vegetables');
  const ticked = toggleShoppingItem(assigned, 1, 'tomatoes', true);
  expect(parseShopping(ticked)[0]).toMatchObject({ text: 'tomatoes', heading: 'Soup', aisle: 'Fruit & vegetables', checked: true });
  const recipe = parseRecipe('soup.md', '# Soup\n\n---\n\n- tomatoes\n- salt\n')!;
  const rebuilt = buildShoppingMarkdown(ticked, [recipe], [recipe]);
  expect(parseShopping(rebuilt).find(item => item.text === 'tomatoes')?.aisle).toBe('Fruit & vegetables');
  expect(shoppingPlainText(rebuilt)).not.toContain('<!--');
  const reset = resetShopping(rebuilt);
  expect(parseShopping(reset)).toEqual([]);
  expect(reset).toContain('Bring bags.');
});
it('groups by explicit aisle, by recipe, or not at all without duplicating items', () => {
  const items = [{ id: '1', content: 'tomatoes', checked: false, labels: ['Fruit & vegetables'], sources: ['Soup'] }, { id: '2', content: 'salt', checked: true, labels: [], sources: ['Soup'] }];
  expect(groupShoppingItems(items, 'section').map(group => group.label)).toEqual(['Fruit & vegetables', 'Other']);
  expect(groupShoppingItems(items, 'recipe').map(group => group.label)).toEqual(['Soup']);
  expect(groupShoppingItems(items, 'none')).toEqual([{ label: '', items }]);
});
