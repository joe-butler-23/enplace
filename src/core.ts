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
  aisle?: string;
};

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
    .filter(({ path }) => path.toLowerCase().endsWith(".md"))
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

export function parseShopping(markdown: string): ShoppingLine[] {
  let heading: string | null = null;
  const result: ShoppingLine[] = [];
  markdown.split(/\r?\n/).forEach((line, index) => {
    const nextHeading = /^##\s+(.+?)\s*$/.exec(line);
    if (nextHeading) heading = nextHeading[1];
    const item = checklistText(line);
    if (item) {
      const aisle = /\s*<!-- aisle: ([^<>\r\n]+) -->$/.exec(item.text);
      result.push({ line: index, heading, ...item, ...(aisle ? { text: item.text.slice(0, aisle.index), aisle: aisle[1] } : {}) });
    }
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
  const checked = new Map<string, boolean>();
  const aisles = new Map<string, string>();
  for (const item of parseShopping(current)) {
    const key = item.text.trim().toLowerCase();
    checked.set(key, item.checked || checked.get(key) === true);
    if (item.aisle) aisles.set(key, item.aisle);
  }
  const titles = new Set(allRecipes.map((recipe) => recipe.title.trim().toLowerCase()));
  const preserved = removeRecipeBlocks(current, titles);
  const prefix = preserved ? `${preserved}${preserved.endsWith("\n") ? "" : "\n"}` : "";
  const seenIngredients = new Set<string>();
  const blocks: string[] = [];
  const recipes = new Map<string, Recipe>();
  for (const recipe of plannedRecipes) recipes.set(recipe.path, recipes.get(recipe.path) ?? recipe);
  for (const recipe of recipes.values()) {
    const lines: string[] = [];
    for (const ingredient of recipe.ingredients) {
      const text = ingredient.trim();
      const key = text.toLowerCase();
      if (!text || seenIngredients.has(key)) continue;
      seenIngredients.add(key);
      lines.push(`- [${checked.get(key) ? "x" : " "}] ${text}${aisles.has(key) ? ` <!-- aisle: ${aisles.get(key)} -->` : ""}`);
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
  const item = resolveShoppingItem(markdown, itemLine, itemText);
  const trailingNewline = markdown.endsWith("\n");
  const lines = markdown.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  lines[item.line] = lines[item.line].replace(/^(\s*-\s+\[)[ xX]*(\])/, `$1${checked ? "x" : " "}$2`);
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function appendShoppingItem(markdown: string, text: string): string {
  const content = text.trim();
  if (!content || /[\r\n]/.test(content)) throw new Error("Shopping item must be one non-empty line.");
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
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
  const item = resolveShoppingItem(markdown, itemLine, itemText);
  const trailingNewline = markdown.endsWith("\n");
  const lines = markdown.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  lines.splice(item.line, 1);
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function setShoppingAisle(markdown: string, itemLine: number, itemText: string, aisle: string): string {
  const label = aisle.trim();
  if (/[<>\r\n]/.test(label) || label.includes('--')) throw new Error('Invalid aisle name');
  const item = resolveShoppingItem(markdown, itemLine, itemText);
  const lines = markdown.split(/\r?\n/);
  lines[item.line] = lines[item.line].replace(/\s*<!-- aisle: [^<>\r\n]+ -->$/, '') + (label ? ` <!-- aisle: ${label} -->` : '');
  return lines.join('\n');
}

export function resetShopping(markdown: string): string {
  return markdown.split(/\r?\n/).filter((line) => !checklistText(line)).join('\n');
}

export function shoppingPlainText(markdown: string): string {
  return markdown.replace(/\s*<!-- aisle: [^<>\r\n]+ -->/g, "").replace(/^(\s*)-\s+\[[ xX]*\]\s+/gm, "$1");
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
