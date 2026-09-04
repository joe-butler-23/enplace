import { parseRecipeDocument } from './recipe-document.js';
import { parseRecipeMD } from './recipemd.js';

/** Marks explicit quantities without inventing amounts or interpreting ingredient identities. */
export function formatIngredient(line: string): string {
  const text = line.trim().replace(/^[-+*]\s+/, '');
  if (/^[*_]/.test(text) || /^\d+\s*(?:[-–]|to\b)/.test(text)) return text;
  const match = /^(\d+\s+\d+\s*\/\s*\d+|\d+\s*[¼½¾⅐-⅞]|\d+\s*\/\s*\d+|[¼½¾⅐-⅞]|\d+(?:[.,]\d+)?)(?:\s*(kg|g|mg|ml|l|litres?|millilitres?|grams?|kilograms?|tbsp|tsp|tablespoons?|teaspoons?|cups?|ounces?|oz|pounds?|lbs?)\b)?\s*(.+)$/i.exec(text);
  return match ? `*${match[1].replace(/(\d)\s*([¼½¾⅐-⅞])/, '$1 $2')}${match[2] ? ` ${match[2]}` : ''}* ${match[3]}` : text;
}

/** Explicit one-time conversion. Existing recipe paths, prose, links and unknown metadata survive. */
export function migrateRecipe(markdown: string, path: string): string {
  try { parseRecipeMD(markdown); return markdown; } catch { /* Legacy input. */ }
  const parsed = parseRecipeDocument(path, markdown);
  const heading = /^##\s+Ingredients\b[^\n]*\n/im.exec(parsed.body);
  if (!heading) throw new Error(`No ingredients section: ${path}`);
  let description = parsed.body.slice(0, heading.index).replace(/^#\s+[^\n]+\n/m, '').trim();
  const remaining = parsed.body.slice(heading.index + heading[0].length);
  const method = /^##\s+(?:Method|Directions|Default Build)\b[^\n]*\n/im.exec(remaining);
  const ingredientSection = method ? remaining.slice(0, method.index) : remaining;
  let instructions = method ? remaining.slice(method.index) : '';
  // Non-list ingredient notes stay visible in the instructions, never become shopping items.
  const notes: string[] = [];
  const ingredients: string[] = [];
  for (const line of ingredientSection.split(/\r?\n/)) {
    if (/^\s*[-+*]\s+/.test(line)) ingredients.push(`- ${formatIngredient(line)}`);
    else if (/^#{1,6}\s+/.test(line) || !line.trim()) ingredients.push(line);
    else notes.push(line);
  }
  if (notes.length) instructions = `${instructions.trim()}\n\n### Ingredient notes\n\n${notes.join('\n')}`;
  const cover = parsed.recipe.cover;
  if (cover && !description.includes(cover)) description = `![${parsed.recipe.title}](<${cover}>)\n\n${description}`.trim();
  if (parsed.view.source) description += `\n\nSource: ${parsed.view.source}`;
  if (parsed.recipe.added) description += `\n\nAdded: ${parsed.recipe.added}`;
  // Unknown fields are retained as readable comments, not imposed on RecipeMD consumers.
  const retained: string[] = [];
  let skip = false;
  for (const line of parsed.rawFrontmatter?.split('\n') ?? []) {
    if (/^[\w-]+:/.test(line)) skip = /^(title|source|cover|added|tags|servings):/.test(line);
    if (!skip) retained.push(line);
  }
  if (retained.length) description += `\n\n<!-- Previous recipe metadata\n${retained.join('\n')}\n-->`;
  const servings = /^servings:\s*(.+)$/m.exec(parsed.rawFrontmatter ?? '')?.[1];
  const tags = parsed.recipe.tags.length ? `*${parsed.recipe.tags.join(', ')}*\n\n` : '';
  const yields = servings ? `**${servings} servings**\n\n` : '';
  const result = `# ${parsed.recipe.title}\n\n${description.trim()}\n\n${tags}${yields}---\n\n${ingredients.join('\n').trim()}\n\n---\n\n${instructions.trim()}\n`;
  parseRecipeMD(result);
  return result;
}
