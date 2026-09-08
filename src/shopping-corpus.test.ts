import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildShoppingMarkdown, mergeShoppingItems, parseRecipe, parseShopping, resolveShoppingAisle, shoppingIngredient } from './core';

type Ingredient = { text: string; purchase: string; aisle: string; include: boolean };
type Case = { title: string; ingredients: Ingredient[] };
// Independently authored and labelled without inspecting the implementation; never derive expected labels from it.
const development: Case[] = JSON.parse(readFileSync(new URL('../tests/fixtures/shopping/development.json', import.meta.url), 'utf8'));

function evaluate(cases: Case[]) {
  const recipes = cases.map(({ title, ingredients }, i) => parseRecipe(`${i}.md`, `# ${title}\n\n---\n\n${ingredients.map(x => `- ${x.text}`).join('\n')}\n\n---\n\nCook.\n`)!);
  const original = structuredClone(recipes);
  const inputs = cases.flatMap(({ title, ingredients }, recipe) => ingredients.map((item, i) => ({ ...item, title, id: `${recipe}:${i}` })));
  const expected = inputs.filter(item => item.include);
  const markdown = buildShoppingMarkdown('', recipes, recipes);
  expect(buildShoppingMarkdown(markdown, recipes, recipes)).toBe(markdown);
  const built = parseShopping(markdown);
  expect.soft(built.map(x => x.text)).toEqual(expected.map(x => x.text));
  expect(recipes).toEqual(original);
  const items = built.map(line => {
    const input = inputs.find(x => x.title === line.heading && x.text === line.text)!;
    return { id: input.id, content: line.text, labels: [], aisle: resolveShoppingAisle(shoppingIngredient(line.text)), sources: [input.title], checked: false };
  });
  const groups = mergeShoppingItems(items);
  const wrongAisles = items.flatMap(item => {
    const expectedAisle = inputs.find(x => x.id === item.id)!.aisle;
    return item.aisle === expectedAisle ? [] : [`${item.content}: ${item.aisle} (expected ${expectedAisle})`];
  });
  const expectedGroups = new Map<string, string[]>();
  for (const item of expected) expectedGroups.set(item.purchase, [...expectedGroups.get(item.purchase) ?? [], item.id]);
  const memberships = (rows: string[][]) => rows.map(ids => [...ids].sort().join(',')).sort();
  const falseMerges = groups.filter(group => new Set(group.memberIds.map(id => inputs.find(x => x.id === id)!.purchase)).size > 1);
  return { items, groups, wrongAisles, falseMerges, actual: memberships(groups.map(group => group.memberIds)), expected: memberships([...expectedGroups.values()]) };
}

const holdout: Case[] = JSON.parse(readFileSync(new URL('../tests/fixtures/shopping/holdout.json', import.meta.url), 'utf8'));
for (const [name, corpus] of [['development', development], ['holdout', holdout], ['combined', [...development, ...holdout]]] as const) describe(`independently judged ${name} recipe shopping corpus`, () => {
  for (const recipe of corpus) it(`${recipe.title}: exact aisles and purchase membership`, () => {
    const result = evaluate([recipe]);
    expect(result.wrongAisles).toEqual([]);
    expect(result.actual).toEqual(result.expected);
  });

  it('combines unfamiliar recipes without false merges, missed merges or lost requirements', () => {
    const result = evaluate(corpus);
    console.info(JSON.stringify({ recipes: corpus.length, ingredients: result.items.length, wrongAisles: result.wrongAisles, unallocated: result.items.filter(x => x.aisle === 'Other').length, falseMerges: result.falseMerges.map(x => x.content), actualGroups: result.actual.length, expectedGroups: result.expected.length }));
    expect(result.wrongAisles).toEqual([]);
    expect(result.actual).toEqual(result.expected);
  });

  it('preserves purchase membership through recipe order, case and spacing changes', () => {
    for (const cases of [[...corpus].reverse(), corpus.map(recipe => ({ ...recipe, ingredients: [...recipe.ingredients].reverse() })), corpus.map(recipe => ({ ...recipe, ingredients: recipe.ingredients.map(item => ({ ...item, text: item.text.toUpperCase().replace(/ /g, '  ') })) }))]) {
      const result = evaluate(cases);
      expect(result.wrongAisles).toEqual([]);
      expect(result.actual).toEqual(result.expected);
    }
  });
});
