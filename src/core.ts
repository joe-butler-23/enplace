import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type Recipe = {
  path: string;
  title: string;
  ingredients: string[];
  method: string[];
  cover: string | null;
  source: string | null;
  added: string | null;
  tags: string[];
  body: string;
  markdown: string;
  link: string;
};

export type Plan = {
  marked: string[];
  days: Map<string, string[]>;
};

export type ShoppingLine = {
  line: number;
  text: string;
  checked: boolean;
  heading: string | null;
};

function frontmatter(raw: string): { values: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { values: {}, body: raw };
  const parsed = parseYaml(match[1]) as unknown;
  return {
    values: parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {},
    body: raw.slice(match[0].length),
  };
}

function sectionItems(body: string, name: string, numbered: boolean): string[] | null {
  const lines = body.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+${name}\\s*$`, "i");
  let start = -1;
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) { fenced = !fenced; continue; }
    if (!fenced && heading.test(lines[index].trim())) { start = index; break; }
  }
  if (start < 0) return null;
  const items: string[] = [];
  fenced = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^#{1,2}\s+/.test(line.trim())) break;
    const match = numbered
      ? /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line)
      : /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
    if (match) items.push(match[1]);
  }
  return items;
}

function cleanScalar(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().replace(/^!?\[\[|\]\]$/g, "").replace(/^<|>$/g, "");
}

function firstImage(body: string): string | null {
  const markdown = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/.exec(body);
  if (markdown) return markdown[1] ?? markdown[2];
  const wiki = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(body);
  return wiki?.[1]?.trim() ?? null;
}

function recipeTags(values: Record<string, unknown>, body: string): string[] {
  const tags = new Set<string>();
  const frontmatterTags = values.tags;
  const valuesToAdd = Array.isArray(frontmatterTags)
    ? frontmatterTags
    : typeof frontmatterTags === "string" ? frontmatterTags.split(/[\s,]+/) : [];
  for (const value of valuesToAdd) {
    if (typeof value === "string" && value.trim()) tags.add(value.trim().replace(/^#/, ""));
  }
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[1]);
  return [...tags].sort((left, right) => left.localeCompare(right));
}

export function recipeBody(markdown: string): string {
  return frontmatter(markdown).body;
}

export type CookLogEntry = { date: string; rating: number | null; makeAgain: boolean | null; notes: string };

export function parseCookLog(markdown: string): CookLogEntry[] {
  const lines = recipeBody(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Cook Log\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const entries: CookLogEntry[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index].trim())) break;
    const header = /^-\s+(.+)$/.exec(lines[index]);
    if (header) {
      const [date, ...fields] = header[1].split("|").map((value) => value.trim());
      const rating = fields.map((field) => /^rating:\s*(-?\d+(?:\.\d+)?)$/i.exec(field)).find(Boolean);
      const again = fields.map((field) => /^make again:\s*(yes|no)$/i.exec(field)).find(Boolean);
      entries.push({ date, rating: rating ? Number(rating[1]) : null, makeAgain: again ? again[1].toLocaleLowerCase() === "yes" : null, notes: "" });
      continue;
    }
    const current = entries[entries.length - 1];
    const note = /^\s+-\s+Notes:\s*(.*)$/i.exec(lines[index]) ?? /^\s{4,}(\S.*)$/.exec(lines[index]);
    if (current && note) current.notes = `${current.notes} ${note[1]}`.trim();
  }
  return entries.filter((entry) => entry.date);
}

export function parseRecipe(path: string, markdown: string): Recipe | null {
  const parsed = frontmatter(markdown);
  const ingredients = sectionItems(parsed.body, "Ingredients", false);
  if (ingredients === null) return null;
  const fallbackTitle = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  const h1 = /^#\s+(.+?)\s*$/m.exec(parsed.body)?.[1]?.trim();
  const title = cleanScalar(parsed.values.title) ?? h1 ?? fallbackTitle;
  return {
    path,
    title,
    ingredients,
    method: sectionItems(parsed.body, "Method", true) ?? [],
    cover: cleanScalar(parsed.values.cover) ?? firstImage(parsed.body),
    source: cleanScalar(parsed.values.source),
    added: cleanScalar(parsed.values.added),
    tags: recipeTags(parsed.values, parsed.body),
    body: parsed.body,
    markdown,
    link: fallbackTitle,
  };
}

export function scanRecipes(files: ReadonlyArray<{ path: string; text: string }>): Recipe[] {
  const recipes = files
    .filter(({ path }) => path.toLowerCase().endsWith(".md"))
    .map(({ path, text }) => parseRecipe(path, text))
    .filter((recipe): recipe is Recipe => recipe !== null);
  const stemCounts = new Map<string, number>();
  for (const recipe of recipes) {
    const stem = recipe.path.split("/").pop()?.replace(/\.md$/i, "") ?? recipe.path;
    const key = stem.toLocaleLowerCase();
    stemCounts.set(key, (stemCounts.get(key) ?? 0) + 1);
  }
  return recipes
    .map((recipe) => {
      const stem = recipe.path.split("/").pop()?.replace(/\.md$/i, "") ?? recipe.path;
      return {
        ...recipe,
        link: stemCounts.get(stem.toLocaleLowerCase()) === 1
          ? stem
          : recipe.path.replace(/\.md$/i, ""),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function replaceRecipeDocument(
  recipes: readonly Recipe[],
  path: string,
  markdown: string,
): Recipe[] {
  const parsed = parseRecipe(path, markdown);
  if (!parsed) return recipes.filter((recipe) => recipe.path !== path);
  const previous = recipes.find((recipe) => recipe.path === path);
  const next = previous ? { ...parsed, link: previous.link } : parsed;
  return previous
    ? recipes.map((recipe) => recipe.path === path ? next : recipe)
    : [...recipes, next];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function parsePlan(markdown: string): Plan {
  const plan: Plan = { marked: [], days: new Map() };
  let destination: string[] | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      if (heading[1].toLocaleLowerCase() === "marked") destination = plan.marked;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(heading[1])) {
        // A merged plan can carry the same date twice when two devices added it at once;
        // both sections belong to that day, and the next save writes one section.
        destination = plan.days.get(heading[1]) ?? [];
        plan.days.set(heading[1], destination);
      } else destination = null;
      continue;
    }
    const item = /^\s*-\s+\[\[([^\]]+)\]\]\s*$/.exec(raw);
    if (destination && item) destination.push(item[1].trim());
  }
  plan.marked = unique(plan.marked);
  for (const [date, entries] of plan.days) {
    const deduplicated = unique(entries);
    if (deduplicated.length) plan.days.set(date, deduplicated);
    else plan.days.delete(date);
  }
  return plan;
}

export function serializePlan(plan: Plan): string {
  const lines = ["## Marked", ...unique(plan.marked).map((entry) => `- [[${entry}]]`)];
  const days = [...plan.days.entries()]
    .filter(([, entries]) => entries.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [date, entries] of days) {
    lines.push("", `## ${date}`, ...unique(entries).map((entry) => `- [[${entry}]]`));
  }
  return `${lines.join("\n")}\n`;
}

export function withMarked(plan: Plan, link: string, marked: boolean): Plan {
  return {
    marked: marked ? unique([...plan.marked, link]) : plan.marked.filter((entry) => entry !== link),
    days: new Map(plan.days),
  };
}

export function withScheduled(plan: Plan, link: string, date: string, scheduled: boolean): Plan {
  const days = new Map([...plan.days].map(([key, entries]) => [key, [...entries]]));
  const entries = days.get(date) ?? [];
  const next = scheduled ? unique([...entries, link]) : entries.filter((entry) => entry !== link);
  if (next.length) days.set(date, next); else days.delete(date);
  return { marked: [...plan.marked], days };
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
  return { marked, days };
}

export function resolveRecipeReference(recipes: readonly Recipe[], reference: string): Recipe | null {
  const normalized = reference.replace(/\\/g, "/").replace(/\.md$/i, "").toLocaleLowerCase();
  return recipes.find((recipe) => recipe.link.toLocaleLowerCase() === normalized)
    ?? recipes.find((recipe) => recipe.path.replace(/\.md$/i, "").toLocaleLowerCase() === normalized)
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
    if (item) result.push({ line: index, heading, ...item });
  });
  return result;
}

function removeRecipeBlocks(markdown: string, recipeTitles: ReadonlySet<string>): string {
  const tokens = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let remove = false;
  return tokens.filter((token) => {
    const heading = /^##\s+(.+?)\s*(?:\n)?$/.exec(token.replace(/\r\n$/, "\n"));
    if (heading) remove = recipeTitles.has(heading[1].trim().toLocaleLowerCase());
    return !remove;
  }).join("");
}

export function buildShoppingMarkdown(
  current: string,
  plannedRecipes: readonly Recipe[],
  allRecipes: readonly Recipe[],
): string {
  const checked = new Map<string, boolean>();
  for (const item of parseShopping(current)) {
    const key = item.text.trim().toLocaleLowerCase();
    checked.set(key, item.checked || (checked.get(key) ?? false));
  }
  const titles = new Set(allRecipes.map((recipe) => recipe.title.trim().toLocaleLowerCase()));
  const preserved = removeRecipeBlocks(current, titles);
  const seenIngredients = new Set<string>();
  const seenRecipes = new Set<string>();
  const generated: string[] = [];
  for (const recipe of plannedRecipes) {
    if (seenRecipes.has(recipe.path)) continue;
    seenRecipes.add(recipe.path);
    const lines: string[] = [];
    for (const ingredient of recipe.ingredients) {
      const text = ingredient.trim();
      const key = text.toLocaleLowerCase();
      if (!text || seenIngredients.has(key)) continue;
      seenIngredients.add(key);
      lines.push(`- [${checked.get(key) ? "x" : " "}] ${text}`);
    }
    if (lines.length) generated.push(`## ${recipe.title}\n${lines.join("\n")}`);
  }
  const prefix = preserved
    ? `${preserved}${preserved.endsWith("\n") ? "" : "\n"}`
    : "";
  return generated.length ? `${prefix}${prefix && !prefix.endsWith("\n\n") ? "\n" : ""}${generated.join("\n\n")}\n` : prefix;
}

export function toggleShoppingItem(markdown: string, itemText: string, checked: boolean): string {
  const item = parseShopping(markdown).find((candidate) => candidate.text === itemText);
  if (!item) throw new Error("Shopping item no longer exists.");
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

export function removeShoppingItem(markdown: string, itemText: string): string {
  const item = parseShopping(markdown).find((candidate) => candidate.text === itemText);
  if (!item) throw new Error("Shopping item no longer exists.");
  const trailingNewline = markdown.endsWith("\n");
  const lines = markdown.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  lines.splice(item.line, 1);
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export function shoppingPlainText(markdown: string): string {
  return markdown.replace(/^(\s*)-\s+\[[ xX]*\]\s+/gm, "$1");
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
  const values: Record<string, string> = { title: input.title.trim() };
  if (input.source?.trim()) values.source = input.source.trim();
  if (input.cover?.trim()) values.cover = input.cover.trim();
  const yaml = stringifyYaml(values, { lineWidth: 0 }).trimEnd();
  const ingredients = input.ingredients.map((line) => `- ${line.trim()}`).join("\n");
  const method = input.method.map((line, index) => `${index + 1}. ${line.trim().replace(/^\d+[.)]\s*/, "")}`).join("\n");
  return `---\n${yaml}\n---\n\n# ${input.title.trim()}\n\n## Ingredients\n\n${ingredients}\n\n## Method\n\n${method}\n`;
}
