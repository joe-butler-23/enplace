import { expect, it } from 'vitest';
import { mergeShoppingItems, normalizeShoppingNoun, resolveShoppingAisle, shoppingIngredient } from './shopping';
const rows = (texts: string[]) => mergeShoppingItems(texts.map((content,i) => ({id:String(i),content,checked:false,labels:[]})));

for (const product of ['tomatoes', 'spinach', 'garlic']) {
  for (const form of ['dried', 'frozen', 'canned']) {
    it(`retains ${form} when preparation is inline for ${product}`, () => {
      const decorated = `${product} chopped and ${form}`;
      expect(rows([product, decorated])).toHaveLength(2);
      expect(shoppingIngredient(decorated).noun).toContain(form);
    });
  }
}
for (const [product, form, aisle] of [['spinach','frozen','Frozen'], ['tomatoes','canned','Tins & jars'], ['chickpeas','dried','Rice, pasta & grains']] as const) {
  for (const preparation of ['chopped', 'finely chopped', 'rinsed']) {
    it(`keeps storage identity and aisle independent of placement: ${form} ${product}, ${preparation}`, () => {
      const variants = [`${form} ${product}`, `${product} (${form})`, `${product} (${preparation}, ${form})`, `${product} (${form}, ${preparation})`];
      expect(variants.map(text=>resolveShoppingAisle(text))).toEqual(variants.map(()=>aisle));
      expect(new Set(variants.map(normalizeShoppingNoun)).size).toBe(1);
      expect(rows(variants.map(text=>`*10 g* ${text}`))[0].memberIds).toHaveLength(4);
    });
  }
}
it.each([
 ['*1 tsp* salt (smoked)', 'salt'],
 ['*100 g* peas (split)', 'peas'],
 ['*1 tbsp* olive oil (garlic infused)', 'olive oil'],
 ['*50 g* flour (self-raising)', 'flour'],
])('does not discard product qualifiers: %s', (text, plain) => {
 expect(rows([text,plain])).toHaveLength(2);
});
it.each([
 ['*1 kg* plus 100 g plus 50 g flour', '1150 g flour'],
 ['*1 tbsp* plus 1 tsp plus 1 tsp olive oil', '5 tsp olive oil'],
])('retains every term of a compound quantity: %s', (text, expected) => {
 expect(rows([text])[0].content).toBe(expected);
});

it.each(['(1 cup / 8 oz)', '(¾ cup)', '(1 ½ cup / 13 ½ oz)'])('alternate measurement %s does not alter purchased quantity', hint => {
  expect(rows([`*220 g* flour ${hint}`, '*30 g* flour'])[0].content).toBe('250 g flour');
});
it.each(['(1 cup flour)', '(1 g salt)', '(½ cup or butter)', '(0/0 g)'])('retains non-measurement annotation %s', annotation => {
  expect(rows([`*220 g* flour ${annotation}`, '*30 g* flour'])).toHaveLength(2);
});
it('preparation alternatives preserve identity without swallowing ingredient alternatives', () => {
  expect(rows(['*100 g* shrimp, cubed or shredded', '*50 g* shrimp'])[0].content).toBe('150 g shrimp');
  expect(rows(['*100 g* shrimp, cubed or tofu', '*50 g* shrimp'])).toHaveLength(2);
});
it.each(['beef (minced or shredded chicken)', 'garlic (crushed or finely chopped ginger)'])('retains an ingredient after a preparation alternative: %s', text => {
  expect(rows([`*200 g* ${text}`, `*200 g* ${text.split(' ')[0]}`])).toHaveLength(2);
});
it.each(['flour plus 20 g plus 30 g', 'flour plus 20 g for dusting plus 30 g for rolling'])('adds every trailing measurement: %s', text => {
  expect(rows([`*100 g* ${text}`])[0].content).toBe('150 g flour');
});
