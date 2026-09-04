import { Lexer, type Token, type Tokens } from "marked";

export type RecipeAmount = { factor: string; unit: string | null };
export type RecipeIngredient = { name: string; amount: RecipeAmount | null; link: string | null };
export type RecipeIngredientGroup = { title: string; ingredients: RecipeIngredient[]; ingredient_groups: RecipeIngredientGroup[] };
export type RecipeMD = {
  title: string; description: string | null; tags: string[]; yields: RecipeAmount[];
  ingredients: RecipeIngredient[]; ingredient_groups: RecipeIngredientGroup[]; instructions: string | null;
};
const fractions: Record<string, number> = { '¼': 1/4, '½': 1/2, '¾': 3/4, '⅐': 1/7, '⅑': 1/9, '⅒': 1/10, '⅓': 1/3, '⅔': 2/3, '⅕': 1/5, '⅖': 2/5, '⅗': 3/5, '⅘': 4/5, '⅙': 1/6, '⅚': 5/6, '⅛': 1/8, '⅜': 3/8, '⅝': 5/8, '⅞': 7/8 };
export function parseAmount(text: string): RecipeAmount | null {
  const value = text.trim();
  if (!value) return null;
  const match = /^(-\s*)?(?:(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d+)\s+([¼-¾⅐-⅞])|(\d+)\s*\/\s*(\d+)|([¼-¾⅐-⅞])|((?:\d*[.,])?\d+))(.*)$/s.exec(value);
  if (!match) throw new Error(`Invalid RecipeMD amount: ${text}`);
  const factor = match[2] ? +match[2] + +match[3]/+match[4] : match[5] ? +match[5] + fractions[match[6]] : match[7] ? +match[7]/+match[8] : match[9] ? fractions[match[9]] : Number(match[10].replace(',', '.'));
  if (!Number.isFinite(factor)) throw new Error(`Invalid RecipeMD amount: ${text}`);
  return { factor: String((match[1] ? -1 : 1) * factor), unit: match[11].trim() || null };
}
const splitComma = (text: string): string[] => text.split(/(?<!\d),|,(?!\d)/).map((part) => part.trim());
const meaningful = (tokens: Token[]): Token[] => tokens.filter((token) => token.type !== 'space' && token.type !== 'def');
function metadata(token: Token | undefined): Tokens.Em | Tokens.Strong | null {
  if (token?.type !== 'paragraph') return null;
  const parts = (token as Tokens.Paragraph).tokens;
  return parts.length === 1 && (parts[0].type === 'em' || parts[0].type === 'strong') ? parts[0] as Tokens.Em | Tokens.Strong : null;
}
function ingredient(item: Tokens.ListItem): RecipeIngredient {
  // Retain Markdown and continuation indentation for round trips and subrecipes.
  let name = item.raw.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '').trimEnd();
  const blocks = meaningful(item.tokens);
  if (!blocks.length) throw new Error('RecipeMD ingredient needs a name');
  const first = blocks[0];
  const inlines = first && 'tokens' in first ? first.tokens as Token[] : [];
  let amount: RecipeAmount | null = null;
  if (inlines?.[0]?.type === 'em') {
    amount = parseAmount((inlines[0] as Tokens.Em).text);
    name = name.slice(inlines[0].raw.length).trim();
  }
  name = name.replace(/[^\S\n]+(?=\n\s*\n)/g, '');
  let link: string | null = null;
  const remaining = inlines?.filter((token, index) => !(index === 0 && token.type === 'em')).filter((token) => token.raw.trim());
  if (blocks.length === 1 && remaining?.length === 1 && remaining[0].type === 'link') {
    const token = remaining[0] as Tokens.Link;
    name = token.text; link = token.href.replace(/ /g, '%20');
  }
  if (!name.trim()) throw new Error('RecipeMD ingredient needs a name');
  return { name: name.trim(), amount, link };
}
/** RecipeMD 2.4 structure over CommonMark tokens. No application metadata is required. */
export function parseRecipeMD(markdown: string): RecipeMD {
  markdown = markdown.replace(/\r\n?/g, "\n");
  const all = Lexer.lex(markdown, { gfm: false });
  const ranges = new Map<Token, { start: number; end: number }>();
  let offset = 0;
  for (const token of all) {
    const start = markdown.indexOf(token.raw, offset);
    ranges.set(token, { start, end: start + token.raw.length });
    offset = start + token.raw.length;
  }
  const tokens = meaningful(all);
  const title = tokens.shift();
  if (title?.type !== 'heading' || (title as Tokens.Heading).depth !== 1) throw new Error('RecipeMD must begin with a level-one title');
  const recipe: RecipeMD = { title: (title as Tokens.Heading).text, description: null, tags: [], yields: [], ingredients: [], ingredient_groups: [], instructions: null };
  const description: Token[] = [];
  while (tokens.length && tokens[0].type !== 'hr' && !metadata(tokens[0])) description.push(tokens.shift()!);
  recipe.description = description.length ? markdown.slice(ranges.get(title)!.end, tokens[0] ? ranges.get(tokens[0])!.start : markdown.length).replace(/^\n+|\s+$/g, '') : null;
  let tags = false, yields = false;
  while (metadata(tokens[0])) {
    const value = metadata(tokens.shift())!;
    if (value.type === 'em') {
      if (tags) throw new Error('RecipeMD has more than one tags paragraph');
      tags = true; recipe.tags = splitComma(value.text);
    } else {
      if (yields) throw new Error('RecipeMD has more than one yields paragraph');
      yields = true; recipe.yields = splitComma(value.text).map(parseAmount).filter((amount): amount is RecipeAmount => amount !== null);
    }
  }
  if (tokens.shift()?.type !== 'hr') throw new Error('RecipeMD needs an ingredient divider');
  const stack: { depth: number; group: RecipeIngredientGroup }[] = [];
  while (tokens.length && tokens[0].type !== 'hr') {
    const token = tokens.shift()!;
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      while (stack.length && stack[stack.length - 1]!.depth >= heading.depth) stack.pop();
      const group: RecipeIngredientGroup = { title: heading.text, ingredients: [], ingredient_groups: [] };
      (stack[stack.length - 1]?.group.ingredient_groups ?? recipe.ingredient_groups).push(group);
      stack.push({ depth: heading.depth, group });
    } else if (token.type === 'list') {
      (stack[stack.length - 1]?.group.ingredients ?? recipe.ingredients).push(...(token as Tokens.List).items.map(ingredient));
    } else throw new Error('RecipeMD instructions need a divider after the ingredients');
  }
  const divider = tokens[0]?.type === 'hr' ? tokens.shift() : null;
  recipe.instructions = divider ? markdown.slice(ranges.get(divider)!.end).replace(/^\n+|\s+$/g, '') || null : null;
  return recipe;
}
export function flattenIngredients(group: Pick<RecipeMD, 'ingredients' | 'ingredient_groups'>): RecipeIngredient[] {
  return [...group.ingredients, ...group.ingredient_groups.flatMap(flattenIngredients)];
}
export function ingredientText(ingredient: RecipeIngredient): string {
  return [ingredient.amount ? `${ingredient.amount.factor}${ingredient.amount.unit ? ` ${ingredient.amount.unit}` : ''}` : '', ingredient.name].filter(Boolean).join(' ').replace(/\s+/g, ' ');
}
