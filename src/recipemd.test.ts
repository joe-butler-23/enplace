import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseRecipeMD } from './recipemd';
const root = new URL('../tests/fixtures/recipemd/', import.meta.url);
describe('RecipeMD upstream conformance', () => {
  for (const file of readdirSync(root).filter((file) => file.endsWith('.md'))) {
    it(file, () => {
      const markdown = readFileSync(new URL(file, root), 'utf8');
      if (file.endsWith('.invalid.md')) expect(() => parseRecipeMD(markdown)).toThrow();
      else expect(parseRecipeMD(markdown)).toEqual(JSON.parse(readFileSync(new URL(file.replace(/\.md$/, '.json'), root), 'utf8')));
    });
  }
});
