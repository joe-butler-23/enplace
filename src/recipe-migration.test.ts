import { expect, it } from 'vitest';
import { migrateRecipe, formatIngredient } from './recipe-migration';
import { parseRecipeMD, flattenIngredients } from './recipemd';
import { parseRecipeDocument } from './recipe-document';
it('converts legacy recipes without losing provenance, groups, yields or notes', () => {
  const source = '---\ntitle: Soup\nsource: https://example.org/soup\ncover: images/soup.webp\nadded: 2026-09-01\ntags: [quick, lunch]\nservings: 2\ncustom: keep\n---\n\n# Soup\n\nA family lunch.\n\n## Ingredients\n- 400 g tomatoes\n\n### Finish\n- 1/2 tsp salt\n\n## Method\n1. Simmer.\n\n## Notes\nKeep this exact note.\n';
  const migrated = migrateRecipe(source, 'soup.md');
  const parsed = parseRecipeMD(migrated);
  expect(parsed.title).toBe('Soup');
  expect(parsed.tags).toEqual(['lunch', 'quick']);
  expect(parsed.yields).toEqual([{ factor: '2', unit: 'servings' }]);
  expect(flattenIngredients(parsed)).toHaveLength(2);
  expect(parsed.ingredient_groups[0].title).toBe('Finish');
  expect(migrated).toContain('custom: keep');
  expect(migrated).toContain('## Notes\nKeep this exact note.');
  const document = parseRecipeDocument('soup.md', migrated);
  expect(document.recipe.cover).toBe('images/soup.webp');
  expect(document.view.source).toBe('https://example.org/soup');
  expect(document.view.directions).toEqual(['Simmer.']);
  expect(migrateRecipe(migrated, 'soup.md')).toBe(migrated);
});
it('keeps ranges honest and marks explicit quantities', () => {
  expect(formatIngredient('2–3 carrots')).toBe('2–3 carrots');
  expect(formatIngredient('250g flour')).toBe('*250 g* flour');
  expect(formatIngredient('salt, to taste')).toBe('salt, to taste');
});

it('preserves mixed Unicode quantities as numeric RecipeMD amounts', () => {
  const ingredient = formatIngredient('1½ tbsp oil');
  const recipe = parseRecipeMD(`# Oil\n\n---\n\n- ${ingredient}\n\n---\n\nMix.\n`);
  expect(flattenIngredients(recipe)[0].amount).toEqual({ factor: '1.5', unit: 'tbsp' });
});
