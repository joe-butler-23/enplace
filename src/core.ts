import {
  type ShoppingItem,
  type ShoppingRow,
  normalizeShoppingNoun,
  classifyShoppingPair,
  shoppingIngredient,
  mergeShoppingItems,
  singularize,
  preparedName,
  inferAisle,
  resolveShoppingAisle,
} from "./shopping.js";
import { formatIngredient } from "./recipe-migration.js";
import { isRecipePath, parseRecipeDocument } from "./recipe-document.js";
export { isRecipePath, parseRecipeDocument, type ParsedRecipeDocument } from "./recipe-document.js";

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

export {
  type ShoppingItem,
  type ShoppingRow,
  normalizeShoppingNoun,
  classifyShoppingPair,
  shoppingIngredient,
  mergeShoppingItems,
  singularize,
  preparedName,
  inferAisle,
  resolveShoppingAisle,
};

/** Canonical shopping noun: handles dialect mapping, singularization, and preparation tails. */
export const shoppingNoun = (name: string): string => normalizeShoppingNoun(name);


export const SHOPPING_AISLES = ['Fruit & vegetables', 'Bakery', 'Meat & fish', 'Dairy & eggs', 'Chilled', 'Frozen', 'Tins & jars', 'Rice, pasta & grains', 'Baking', 'Herbs, spices & oils', 'Drinks', 'Household', 'Other'];

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

type MarkdownLine = { text: string; raw: string };

function shoppingMarkdownLines(markdown: string): MarkdownLine[] {
  const raw = markdown.match(/[^\r\n]*(?:\r\n|[\r\n]|$)/g) ?? [];
  if (raw[raw.length - 1] === "") raw.pop();
  return raw.map((line) => ({ text: line.replace(/\r\n|[\r\n]$/, ""), raw: line }));
}

/**
 * CommonMark fenced code and block HTML are examples, not shopping content. This deliberately
 * recognises the block forms used by CommonMark, at any list indentation; it does not try to
 * interpret inline HTML.
 */
function opaqueShoppingLines(lines: readonly MarkdownLine[]): Set<number> {
  const opaque = new Set<number>();
  let fence: { character: "`" | "~"; length: number } | null = null;
  let htmlEnd: RegExp | null = null;
  let htmlUntilBlank = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].text;
    if (fence) {
      opaque.add(index);
      const close = new RegExp(`^[\\t ]*${fence.character}{${fence.length},}[\\t ]*$`);
      if (close.test(line)) fence = null;
      continue;
    }
    if (htmlEnd) {
      opaque.add(index);
      if (htmlEnd.test(line)) htmlEnd = null;
      continue;
    }
    if (htmlUntilBlank) {
      opaque.add(index);
      if (!line.trim()) htmlUntilBlank = false;
      continue;
    }
    const openingFence = /^[\t ]*(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      opaque.add(index);
      fence = { character: openingFence[1][0] as "`" | "~", length: openingFence[1].length };
      continue;
    }
    const trimmed = line.trimStart();
    const namedHtml = /^<(script|pre|style|textarea)(?:\s|>|$)/i.exec(trimmed);
    if (namedHtml) {
      opaque.add(index);
      htmlEnd = new RegExp(`</${namedHtml[1]}\\s*>`, "i");
      if (htmlEnd.test(trimmed)) htmlEnd = null;
      continue;
    }
    if (/^<!--/.test(trimmed)) {
      opaque.add(index);
      if (!/-->/.test(trimmed)) htmlEnd = /-->/;
      continue;
    }
    if (/^<\?/.test(trimmed)) {
      opaque.add(index);
      if (!/\?>/.test(trimmed)) htmlEnd = /\?>/;
      continue;
    }
    if (/^<!\[CDATA\[/i.test(trimmed)) {
      opaque.add(index);
      if (!/\]\]>/.test(trimmed)) htmlEnd = /\]\]>/;
      continue;
    }
    if (/^<![A-Z]/.test(trimmed) || /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|ol|p|pre|script|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i.test(trimmed)) {
      opaque.add(index);
      htmlUntilBlank = true;
    }
  }
  return opaque;
}

function canonicalChecklistLine(line: MarkdownLine): MarkdownLine {
  return { ...line, raw: line.raw.replace(/^([ \t]*-[ \t]+\[)([ xX]*)(\])(?=[ \t]+)/, (_match, before: string, marks: string, after: string) =>
    `${before}${/x/i.test(marks) ? "x" : " "}${after}`) };
}

/** Repairs tolerated live checklist markers while preserving opaque Markdown bytes. */
export function canonicalShoppingMarkdown(markdown: string): string {
  const lines = shoppingMarkdownLines(markdown);
  const opaque = opaqueShoppingLines(lines);
  return lines.map((line, index) => opaque.has(index) ? line.raw : canonicalChecklistLine(line).raw).join("");
}

export function parseShopping(markdown: string): ShoppingLine[] {
  const lines = shoppingMarkdownLines(markdown);
  const opaque = opaqueShoppingLines(lines);
  let heading: string | null = null;
  const result: ShoppingLine[] = [];
  lines.forEach(({ text }, index) => {
    if (opaque.has(index)) return;
    const nextHeading = /^##\s+(.+?)\s*$/.exec(text);
    if (nextHeading) heading = nextHeading[1];
    const item = checklistText(text);
    if (item) result.push({ line: index, heading, ...item });
  });
  return result;
}

const shoppingKey = (text: string) => text.trim().toLowerCase();
const escapeShoppingKey = (key: string) => key.replace(/%/g, "%25").replace(/;/g, "%3B").replace(/-->/g, "--%3E");

function recipeMarker(path: string, keys: readonly string[]): string {
  return `<!-- enplace-shopping:recipe ${encodeURIComponent(path)} | ${keys.map(escapeShoppingKey).join("; ")} -->`;
}

type RecipeMarker = { path: string; keys: Set<string> };

function markedRecipe(line: string): RecipeMarker | null {
  const match = /^<!-- enplace-shopping:recipe ([^ >]+) \| (.*) -->$/.exec(line);
  if (!match || match[2].includes("-->")) return null;
  try {
    const keys = match[2] ? match[2].split("; ").map((key) => decodeURIComponent(key)) : [];
    return { path: decodeURIComponent(match[1]), keys: new Set(keys) };
  } catch {
    return null;
  }
}

function generatedIngredients(recipe: Recipe, checked: ReadonlyMap<string, boolean>): { key: string; line: string }[] {
  const seenIngredients = new Set<string>();
  const lines: { key: string; line: string }[] = [];
  for (const ingredient of recipe.ingredients) {
    const text = ingredient.trim();
    const key = shoppingKey(text);
    if (!text || seenIngredients.has(key) || /^(?:(?:tap|cold|hot|warm|boiling) )?water$|^ice(?: cube)?s?$/.test(shoppingIngredient(text).noun)) continue;
    seenIngredients.add(key);
    lines.push({ key, line: `- [${checked.get(key) ? "x" : " "}] ${text}` });
  }
  return lines;
}

type GeneratedRecipe = {
  path: string;
  marker: number;
  heading: number;
  insertion: number;
  generatedLines: Set<number>;
  checked: Map<string, boolean>;
};

function generatedRecipes(lines: readonly MarkdownLine[], opaque: ReadonlySet<number>): GeneratedRecipe[] {
  const markers = lines.map(({ text }) => markedRecipe(text));
  const markerIndexes = markers.flatMap((marker, index) => marker === null ? [] : [index]);
  const recipes: GeneratedRecipe[] = [];
  for (let position = 0; position < markerIndexes.length; position += 1) {
    const marker = markerIndexes[position];
    const ownership = markers[marker]!;
    const limit = markerIndexes[position + 1] ?? lines.length;
    const heading = marker + 1 < limit && /^##\s+/.test(lines[marker + 1].text) ? marker + 1 : null;
    if (heading === null) continue;
    const generatedLines = new Set<number>();
    const checked = new Map<string, boolean>();
    for (let index = heading + 1; index < limit; index += 1) {
      if (opaque.has(index)) continue;
      const item = checklistText(lines[index].text);
      if (!item) continue;
      const key = shoppingKey(item.text);
      if (!ownership.keys.has(key)) continue;
      generatedLines.add(index);
      checked.set(key, item.checked || checked.get(key) === true);
    }
    recipes.push({ path: ownership.path, marker, heading, insertion: generatedLines.values().next().value ?? heading + 1, generatedLines, checked });
  }
  return recipes;
}

/**
 * Rebuild only lines tagged by a previous build. Old untagged sections are intentionally kept:
 * their origin cannot be established, so they may be handwriting rather than stale output.
 */
export function buildShoppingMarkdown(
  current: string,
  plannedRecipes: readonly Recipe[],
  _allRecipes: readonly Recipe[],
): string {
  const canonical = canonicalShoppingMarkdown(current);
  const lines = shoppingMarkdownLines(canonical);
  const opaque = opaqueShoppingLines(lines);
  const previous = generatedRecipes(lines, opaque);
  const planned = new Map<string, Recipe>();
  for (const recipe of plannedRecipes) planned.set(recipe.path, planned.get(recipe.path) ?? recipe);
  const previousByMarker = new Map(previous.map((recipe) => [recipe.marker, recipe]));
  const previousByHeading = new Map(previous.flatMap((recipe) => recipe.heading === null ? [] : [[recipe.heading, recipe] as const]));
  const previousByGeneratedLine = new Map<number, GeneratedRecipe>();
  const skipped = new Set<number>();
  for (const recipe of previous) {
    for (const line of recipe.generatedLines) previousByGeneratedLine.set(line, recipe);
    skipped.add(recipe.marker);
    if (recipe.heading !== null) skipped.add(recipe.heading);
    for (const line of recipe.generatedLines) skipped.add(line);
  }
  const emitted = new Set<string>();
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const recipe = previousByMarker.get(index);
    if (recipe) {
      const next = planned.get(recipe.path);
      if (!next) continue;
      emitted.add(next.path);
      output.push(`${recipeMarker(next.path, generatedIngredients(next, recipe.checked).map(({ key }) => key))}${lines[index].raw.slice(lines[index].text.length)}`);
      continue;
    }
    const owner = previousByGeneratedLine.get(index);
    if (owner) {
      const recipe = planned.get(owner.path);
      if (recipe && index === owner.insertion) output.push(...generatedIngredients(recipe, owner.checked).map(({ line }) => `${line}\n`));
      continue;
    }
    if (skipped.has(index)) {
      const owner = previousByHeading.get(index);
      const recipe = owner && planned.get(owner.path);
      if (recipe) {
        output.push(`## ${recipe.title}${lines[index].raw.slice(lines[index].text.length)}`);
        if (owner.generatedLines.size === 0) output.push(...generatedIngredients(recipe, owner.checked).map(({ line }) => `${line}\n`));
      }
      continue;
    }
    output.push(lines[index].raw);
  }
  const blocks = [...planned.values()].filter((recipe) => !emitted.has(recipe.path)).map((recipe) =>
    [recipeMarker(recipe.path, generatedIngredients(recipe, new Map()).map(({ key }) => key)), `## ${recipe.title}`, ...generatedIngredients(recipe, new Map()).map(({ line }) => line)].join("\n"));
  const preserved = output.join("");
  if (!blocks.length) return preserved;
  const separator = !preserved ? "" : preserved.endsWith("\n\n") ? "" : preserved.endsWith("\n") ? "\n" : "\n\n";
  return `${preserved}${separator}${blocks.join("\n\n")}\n`;
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
  const lines = shoppingMarkdownLines(canonical);
  lines[item.line] = { ...lines[item.line], raw: lines[item.line].raw.replace(/^(\s*-\s+\[)[ xX]*(\])/, `$1${checked ? "x" : " "}$2`) };
  return lines.map((line) => line.raw).join("");
}

export function appendShoppingItem(markdown: string, text: string): string {
  const content = text.trim();
  if (!content || /[\r\n]/.test(content)) throw new Error("Shopping item must be one non-empty line.");
  const canonical = canonicalShoppingMarkdown(markdown);
  const lines = shoppingMarkdownLines(canonical);
  const opaque = opaqueShoppingLines(lines);
  const otherHeading = lines.findIndex((line, index) => !opaque.has(index) && /^##\s+Other\s*$/i.test(line.text));
  const newline = canonical.includes("\r\n") ? "\r\n" : "\n";
  if (otherHeading >= 0) {
    let insertion = lines.findIndex((line, index) => index > otherHeading && !opaque.has(index) && /^##\s+/.test(line.text));
    if (insertion < 0) insertion = lines.length;
    while (insertion > otherHeading + 1 && lines[insertion - 1].text.trim() === "") insertion -= 1;
    const offset = lines.slice(0, insertion).reduce((length, line) => length + line.raw.length, 0);
    const before = canonical.slice(0, offset);
    const needsNewline = before.length > 0 && !/(?:\r\n|[\r\n])$/.test(before);
    return `${before}${needsNewline ? newline : ""}- [ ] ${content}${newline}${canonical.slice(offset)}`;
  }
  const needsNewline = canonical.length > 0 && !/(?:\r\n|[\r\n])$/.test(canonical);
  const separator = canonical.length === 0 ? "" : `${needsNewline ? newline : ""}${canonical.endsWith(`${newline}${newline}`) ? "" : newline}`;
  return `${canonical}${separator}## Other${newline}- [ ] ${content}${newline}`;
}

export function removeShoppingItem(markdown: string, itemLine: number, itemText: string): string {
  const canonical = canonicalShoppingMarkdown(markdown);
  const item = resolveShoppingItem(canonical, itemLine, itemText);
  const lines = shoppingMarkdownLines(canonical);
  lines.splice(item.line, 1);
  return lines.map((line) => line.raw).join("");
}

export function resetShopping(markdown: string): string {
  const canonical = canonicalShoppingMarkdown(markdown);
  const lines = shoppingMarkdownLines(canonical);
  const opaque = opaqueShoppingLines(lines);
  return lines.filter((line, index) => opaque.has(index) || !checklistText(line.text)).map((line) => line.raw).join("");
}

export function shoppingPlainText(markdown: string): string {
  const lines = shoppingMarkdownLines(markdown);
  const opaque = opaqueShoppingLines(lines);
  return lines.map((line, index) => {
    if (markedRecipe(line.text)) return "";
    if (opaque.has(index)) return line.raw;
    const item = checklistText(line.text);
    return item ? `${line.text.match(/^(\s*)/)![1]}${shoppingIngredient(item.text).display}${line.raw.slice(line.text.length)}` : line.raw;
  }).join("");
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
