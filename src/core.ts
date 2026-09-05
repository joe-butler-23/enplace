import { parseRecipeIngredient, type RecipeAmount } from "./recipemd.js";
import { formatIngredient } from "./recipe-migration.js";
import { parseRecipeDocument } from "./recipe-document.js";
export { parseRecipeDocument, type ParsedRecipeDocument } from "./recipe-document.js";

export type Recipe = {
  path: string;
  title: string;
  ingredients: string[];
  cover: string | null;
  added: string | null;
  tags: string[];
  link: string;
};

export type Plan = {
  marked: string[];
  days: Map<string, string[]>;
  notes: Map<string, string>;
};

export type ShoppingLine = {
  line: number;
  text: string;
  checked: boolean;
  heading: string | null;
};

export type ShoppingItem = {
  id: string; content: string; labels: string[]; sources?: string[]; checked: boolean;
};
export type ShoppingRow = ShoppingItem & { memberIds: string[] };

/** Authoring owns noun spelling; no plural, unit, or quantity inference. */
export const shoppingNoun = (name: string): string => name.split(',', 1)[0].trim().toLowerCase();

export function shoppingIngredient(text: string): { noun: string; name: string; display: string; amount: RecipeAmount | null } {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  try {
    const ingredient = parseRecipeIngredient(clean);
    return { noun: shoppingNoun(ingredient.name), name: ingredient.name, display: ingredient.display, amount: ingredient.amount };
  } catch {
    return { noun: shoppingNoun(clean), name: clean, display: clean, amount: null };
  }
}

export function mergeShoppingItems(items: readonly ShoppingItem[]): ShoppingRow[] {
  const groups = new Map<string, { row: ShoppingRow; amounts: Map<string | null, number>; unquantified: Map<string, string> }>();
  for (const item of items) {
    const { noun, name, display, amount } = shoppingIngredient(item.content);
    let group = groups.get(noun);
    if (!group) {
      group = { row: { ...item, content: name.split(',', 1)[0].trim(), sources: [], memberIds: [], checked: true }, amounts: new Map(), unquantified: new Map() };
      groups.set(noun, group);
    }
    group.row.memberIds.push(item.id);
    group.row.sources = unique([...group.row.sources ?? [], ...item.sources ?? []]);
    group.row.checked &&= item.checked;
    if (amount) group.amounts.set(amount.unit, (group.amounts.get(amount.unit) ?? 0) + Number(amount.factor));
    else if (!group.unquantified.has(display.toLowerCase())) group.unquantified.set(display.toLowerCase(), display);
  }
  return [...groups.values()].map(({ row, amounts, unquantified }) => {
    const quantities = [...amounts].map(([unit, factor]) => `${Number(factor.toPrecision(12))}${unit ? ` ${unit}` : ''}`);
    const quantified = quantities.length ? `${row.content} ${quantities.join(' + ')}` : '';
    return { ...row, content: [quantified, ...unquantified.values()].filter(Boolean).join(' + ') };
  });
}

export const SHOPPING_AISLES = ['Fruit & vegetables', 'Bakery', 'Meat & fish', 'Dairy & eggs', 'Chilled', 'Frozen', 'Tins & jars', 'Rice, pasta & grains', 'Baking', 'Herbs, spices & oils', 'Drinks', 'Household'];

export function parseAisles(markdown: string): Map<string, string> {
  const aisles = new Map<string, string>();
  let aisle = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) aisle = SHOPPING_AISLES.includes(heading[1]) ? heading[1] : '';
    const noun = /^\s*-\s+(.+?)\s*$/.exec(line)?.[1];
    if (aisle && noun) aisles.set(shoppingNoun(noun), aisle);
  }
  return aisles;
}

export function setAisle(markdown: string, name: string, aisle: string): string {
  const noun = shoppingNoun(name);
  if (!noun || /[\r\n]/.test(name)) throw new Error('Invalid shopping noun');
  if (aisle && !SHOPPING_AISLES.includes(aisle)) throw new Error('Invalid aisle');
  const aisles = parseAisles(markdown);
  if (aisle) aisles.set(noun, aisle); else aisles.delete(noun);
  return SHOPPING_AISLES.flatMap(label => {
    const nouns = [...aisles].filter(([, assigned]) => assigned === label).map(([key]) => key).sort();
    return nouns.length ? [`## ${label}\n${nouns.map(key => `- ${key}`).join('\n')}\n`] : [];
  }).join('\n');
}

export const isRecipePath = (path: string): boolean => /\.md$/i.test(path) && !['Plan.md', 'Shopping.md', 'Aisles.md'].includes(path);

export function parseRecipe(path: string, markdown: string): Recipe | null {
  const parsed = parseRecipeDocument(path, markdown);
  if (parsed.recipe.ingredients === null) return null;
  return {
    path,
    ...parsed.recipe,
    ingredients: parsed.recipe.ingredients,
    link: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
  };
}

const recipeStem = (path: string): string => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;

/** Allocates links and catalogue order for any complete set of parsed recipes. */
export function finalizeRecipes(recipes: readonly Recipe[]): Recipe[] {
  const stemCounts = new Map<string, number>();
  for (const recipe of recipes) {
    const stem = recipeStem(recipe.path).toLowerCase();
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }
  return recipes.map((recipe) => {
    const stem = recipeStem(recipe.path);
    const link = stemCounts.get(stem.toLowerCase()) === 1 ? stem : recipe.path.replace(/\.md$/i, "");
    return recipe.link === link ? recipe : { ...recipe, link };
  }).sort((left, right) => left.title.localeCompare(right.title));
}

export function scanRecipes(files: ReadonlyArray<{ path: string; text: string }>): Recipe[] {
  return finalizeRecipes(files
    .filter(({ path }) => isRecipePath(path))
    .map(({ path, text }) => parseRecipe(path, text))
    .filter((recipe): recipe is Recipe => recipe !== null));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

type PlanSection = { entries: string[] | null; date: string | null };

function planSection(plan: Plan, heading: string): PlanSection {
  if (heading.toLowerCase() === "marked") return { entries: plan.marked, date: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(heading)) return { entries: null, date: null };
  // Concurrent additions can duplicate a date heading. Both sections belong to the same day.
  const entries = plan.days.get(heading) ?? [];
  plan.days.set(heading, entries);
  return { entries, date: heading };
}

export function parsePlan(markdown: string): Plan {
  const plan: Plan = { marked: [], days: new Map(), notes: new Map() };
  let section: PlanSection = { entries: null, date: null };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = planSection(plan, heading[1]);
      continue;
    }
    const note = section.date ? /^\s*>\s?(.*?)\s*$/.exec(line)?.[1]?.trim() : undefined;
    if (section.date && note) plan.notes.set(section.date, note);
    const item = /^\s*-\s+\[\[([^\]]+)\]\]\s*$/.exec(line);
    if (section.entries && item) {
      const value = item[1].trim();
      if (!section.entries.includes(value)) section.entries.push(value);
    }
  }
  for (const [day, entries] of plan.days) if (!entries.length) plan.days.delete(day);
  return plan;
}

export function serializePlan(plan: Plan): string {
  const lines = ["## Marked", ...unique(plan.marked).map((entry) => `- [[${entry}]]`)];
  const dates = unique([...plan.days.keys(), ...plan.notes.keys()]).sort((left, right) => left.localeCompare(right));
  for (const date of dates) {
    const entries = unique(plan.days.get(date) ?? []);
    const note = plan.notes.get(date)?.replace(/\s*\r?\n\s*/g, " ").trim() ?? "";
    if (!entries.length && !note) continue;
    lines.push("", `## ${date}`);
    if (note) lines.push(`> ${note}`);
    lines.push(...entries.map((entry) => `- [[${entry}]]`));
  }
  return `${lines.join("\n")}\n`;
}

export type RecipePlanning = { marked: boolean; scheduledDates: string[] };

export function recipePlanning(plan: Plan, link: string): RecipePlanning {
  return {
    marked: plan.marked.includes(link),
    scheduledDates: [...plan.days]
      .filter(([, entries]) => entries.includes(link))
      .map(([date]) => date)
      .sort(),
  };
}

export function withRecipePlanning(plan: Plan, link: string, planning: RecipePlanning): Plan {
  const marked = planning.marked
    ? unique([...plan.marked, link])
    : plan.marked.filter((entry) => entry !== link);
  const targetDates = new Set(unique(planning.scheduledDates)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  const days = new Map<string, string[]>();
  for (const [date, entries] of plan.days) {
    const hadRecipe = entries.includes(link);
    if (!hadRecipe || targetDates.has(date)) days.set(date, [...entries]);
    else {
      const remaining = entries.filter((entry) => entry !== link);
      if (remaining.length) days.set(date, remaining);
    }
    if (hadRecipe) targetDates.delete(date);
  }
  for (const date of [...targetDates].sort()) {
    days.set(date, unique([...(days.get(date) ?? []), link]));
  }
  return { marked, days, notes: new Map(plan.notes) };
}

export function resolveRecipeReference(recipes: readonly Recipe[], reference: string): Recipe | null {
  const normalized = reference.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
  return recipes.find((recipe) => recipe.link.toLowerCase() === normalized)
    ?? recipes.find((recipe) => recipe.path.replace(/\.md$/i, "").toLowerCase() === normalized)
    ?? null;
}

/**
 * Two devices ticking the same item at the same moment both replace the box character, and the
 * text merge keeps both, so a box can read `[xx]` or `[  ]` until the next toggle rewrites it.
 * Any mark counts as checked; a malformed box is never a reason to drop the item.
 */
function checklistText(line: string): { text: string; checked: boolean } | null {
  const match = /^\s*-\s+\[([ xX]*)\]\s+(.+?)\s*$/.exec(line);
  return match ? { text: match[2], checked: /x/i.test(match[1]) } : null;
}

/** Repairs every tolerated checklist marker while preserving all other Markdown bytes. */
export function canonicalShoppingMarkdown(markdown: string): string {
  return markdown.replace(/^([ \t]*-[ \t]+\[)([ xX]*)(\])(?=[ \t]+)/gm, (_match, before: string, marks: string, after: string) =>
    `${before}${/x/i.test(marks) ? "x" : " "}${after}`);
}

export function parseShopping(markdown: string): ShoppingLine[] {
  let heading: string | null = null;
  const result: ShoppingLine[] = [];
  markdown.split(/\r?\n/).forEach((line, index) => {
    const nextHeading = /^##\s+(.+?)\s*$/.exec(line);
    if (nextHeading) heading = nextHeading[1];
    const item = checklistText(line);
    if (item) result.push({ line: index, heading, ...item });
  });
  return result;
}

function removeRecipeBlocks(markdown: string, recipeTitles: ReadonlySet<string>): string {
  const tokens = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let remove = false;
  return tokens.filter((token) => {
    const heading = /^##\s+(.+?)\s*(?:\n)?$/.exec(token.replace(/\r\n$/, "\n"));
    if (heading) remove = recipeTitles.has(heading[1].trim().toLowerCase());
    return !remove;
  }).join("");
}

export function buildShoppingMarkdown(
  current: string,
  plannedRecipes: readonly Recipe[],
  allRecipes: readonly Recipe[],
): string {
  const canonical = canonicalShoppingMarkdown(current);
  const checked = new Map<string, boolean>();
  const headingOccurrences = new Map<string, number>();
  let block = "";
  for (const line of canonical.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim().toLowerCase();
    if (heading) {
      const occurrence = (headingOccurrences.get(heading) ?? 0) + 1;
      headingOccurrences.set(heading, occurrence);
      block = `${heading}\0${occurrence}`;
    }
    const item = checklistText(line);
    if (!item || !block) continue;
    const text = item.text.trim().toLowerCase();
    const key = `${block}\0${text}`;
    checked.set(key, item.checked || checked.get(key) === true);
  }
  const titles = new Set(allRecipes.map((recipe) => recipe.title.trim().toLowerCase()));
  const preserved = removeRecipeBlocks(canonical, titles);
  const prefix = preserved ? `${preserved}${preserved.endsWith("\n") ? "" : "\n"}` : "";
  const blocks: string[] = [];
  const recipes = new Map<string, Recipe>();
  for (const recipe of plannedRecipes) recipes.set(recipe.path, recipes.get(recipe.path) ?? recipe);
  const outputOccurrences = new Map<string, number>();
  for (const recipe of recipes.values()) {
    const heading = recipe.title.trim().toLowerCase();
    const occurrence = (outputOccurrences.get(heading) ?? 0) + 1;
    outputOccurrences.set(heading, occurrence);
    const blockKey = `${heading}\0${occurrence}`;
    const seenIngredients = new Set<string>();
    const lines: string[] = [];
    for (const ingredient of recipe.ingredients) {
      const text = ingredient.trim();
      const ingredientKey = text.toLowerCase();
      if (!text || seenIngredients.has(ingredientKey)) continue;
      seenIngredients.add(ingredientKey);
      const key = `${blockKey}\0${ingredientKey}`;
      lines.push(`- [${checked.get(key) ? "x" : " "}] ${text}`);
    }
    if (lines.length) blocks.push(`## ${recipe.title}\n${lines.join("\n")}`);
  }
  if (!blocks.length) return prefix;
  const separator = /(?:^|\n\n)$/.test(prefix) ? "" : "\n";
  return `${prefix}${separator}${blocks.join("\n\n")}\n`;
}

function resolveShoppingItem(markdown: string, itemLine: number, itemText: string): ShoppingLine {
  const items = parseShopping(markdown);
  const exact = items.find((candidate) => candidate.line === itemLine && candidate.text === itemText);
  if (exact) return exact;
  const matchingText = items.filter((candidate) => candidate.text === itemText);
  if (matchingText.length === 1) return matchingText[0];
  throw new Error("Shopping item no longer exists");
}

export function toggleShoppingItem(markdown: string, itemLine: number, itemText: string, checked: boolean): string {
  const canonical = canonicalShoppingMarkdown(markdown);
  const item = resolveShoppingItem(canonical, itemLine, itemText);
  const trailingNewline = canonical.endsWith("\n");
  const lines = canonical.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  lines[item.line] = lines[item.line].replace(/^(\s*-\s+\[)[ xX]*(\])/, `$1${checked ? "x" : " "}$2`);
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function appendShoppingItem(markdown: string, text: string): string {
  const content = text.trim();
  if (!content || /[\r\n]/.test(content)) throw new Error("Shopping item must be one non-empty line.");
  const lines = canonicalShoppingMarkdown(markdown).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const otherHeading = lines.findIndex((line) => /^##\s+Other\s*$/i.test(line));
  if (otherHeading >= 0) {
    let insertion = lines.findIndex((line, index) => index > otherHeading && /^##\s+/.test(line));
    if (insertion < 0) insertion = lines.length;
    while (insertion > otherHeading + 1 && lines[insertion - 1].trim() === "") insertion -= 1;
    lines.splice(insertion, 0, `- [ ] ${content}`);
    return `${lines.join("\n")}\n`;
  }
  const prefix = lines.length === 1 && lines[0] === "" ? "" : `${lines.join("\n")}\n\n`;
  return `${prefix}## Other\n- [ ] ${content}\n`;
}

export function removeShoppingItem(markdown: string, itemLine: number, itemText: string): string {
  const canonical = canonicalShoppingMarkdown(markdown);
  const item = resolveShoppingItem(canonical, itemLine, itemText);
  const trailingNewline = canonical.endsWith("\n");
  const lines = canonical.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  lines.splice(item.line, 1);
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function resetShopping(markdown: string): string {
  return canonicalShoppingMarkdown(markdown).split(/\r?\n/).filter((line) => !checklistText(line)).join('\n');
}

export function shoppingPlainText(markdown: string): string {
  return markdown.replace(/^([ \t]*)-\s+\[[ xX]*\]\s+(.+)$/gm,
    (_match, indent: string, text: string) => indent + shoppingIngredient(text).display);
}

export function resolveRelativePath(documentPath: string, reference: string): string | null {
  if (/^(?:https?:|data:|blob:)/i.test(reference)) return reference;
  const clean = reference.split("#", 1)[0].split("?", 1)[0].replace(/^\/+/, "");
  const segments = `${documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : ""}${clean}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) return null;
      resolved.pop();
    } else resolved.push(segment);
  }
  return resolved.join("/");
}

export function renderImportedRecipe(input: {
  title: string;
  ingredients: string[];
  method: string[];
  source?: string;
  cover?: string;
}): string {
  const description = [input.cover?.trim() ? `![${input.title.trim()}](<${input.cover.trim()}>)` : '', input.source?.trim() ? `Source: ${input.source.trim()}` : ''].filter(Boolean).join("\n\n");
  const ingredients = input.ingredients.map((line) => `- ${formatIngredient(line)}`).join("\n");
  const method = input.method.map((line, index) => `${index + 1}. ${line.trim().replace(/^\d+[.)]\s*/, "")}`).join("\n");
  return `# ${input.title.trim()}\n\n${description ? description + '\n\n' : ''}---\n\n${ingredients}\n\n---\n\n${method}\n`;
}
