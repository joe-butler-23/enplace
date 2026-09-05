import { expect, it } from 'vitest';
import { groupShoppingItems } from './views/components/ShoppingListView';
it('groups by explicit aisle, by recipe, or not at all without duplicating items', () => {
  const items = [{ id: '1', content: 'tomatoes', checked: false, labels: ['Fruit & vegetables'], sources: ['Soup'] }, { id: '2', content: 'salt', checked: true, labels: [], sources: ['Soup'] }];
  expect(groupShoppingItems(items, 'section').map(group => group.label)).toEqual(['Fruit & vegetables', 'Other']);
  expect(groupShoppingItems(items, 'recipe').map(group => group.label)).toEqual(['Soup']);
  expect(groupShoppingItems(items, 'none')[0].items.map(item => item.content)).toEqual(['tomatoes', 'salt']);
});
