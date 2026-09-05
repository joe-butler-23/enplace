import { parseRecipeMD, flattenIngredients, ingredientText, type RecipeMD } from "./recipemd.js";
export type ParsedRecipeDocument = {
  recipeMD?: RecipeMD;
  path: string;
  markdown: string;
  /** Legacy Preact/editor body framing. Strict catalogue/CLI framing stays in the recipe projection. */
  body: string;
  /** Legacy Preact/editor raw frontmatter. */
  rawFrontmatter: string | null;
  /** Raw scalar/list policy retained for Preact presentation and editor round-tripping. */
  frontmatter: Record<string, unknown>;
  recipe: {
    title: string;
    ingredients: string[] | null;
    cover: string | null;
    added: string | null;
    tags: string[];
  };
  /** Deliberately presentation-specific interpretations of the same syntax scan. */
  view: {
    title: string | null;
    ingredients: string[];
    directions: string[];
    declaredCover: string | null;
    leadingImage: { src: string; alt: string; bodyWithoutImage: string } | null;
    source: string | null;
    tags: string[];
  };
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\(["\\nt])/g, (_, char: string) => ({ n: "\n", t: "\t" }[char] ?? char)) : inner.replace(/''/g, "'");
  }
  return trimmed;
}

function cleanScalar(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().replace(/^!?\[\[|\]\]$/g, "").replace(/^<|>$/g, "");
}

function stripWrappedQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  return ((trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') || (trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'"))
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function presentationValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  const unquoted = stripWrappedQuotes(trimmed);
  const lower = unquoted.toLowerCase();
  if (lower === "null" || lower === "undefined") return null;
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    const inner = unquoted.slice(1, -1).trim();
    return inner ? inner.split(",").map(stripWrappedQuotes).map((entry) => entry.trim()).filter(Boolean) : [];
  }
  if (unquoted.includes(",") && !unquoted.includes("://")) {
    const entries = unquoted.split(",").map(stripWrappedQuotes).map((entry) => entry.trim()).filter(Boolean);
    if (entries.length > 1) return entries;
  }
  return unquoted;
}

const DISPLAY_DIRECTIONS_HEADING = /^##\s+(Directions|Method)\b/i;
const DISPLAY_INGREDIENTS_HEADING = /^##\s+Ingredients\b/i;
const DISPLAY_SUBHEADING = /^#{3,6}\s/;
const DISPLAY_LIST_ITEM = /^(?:\d+\.|[-*+])\s+(.*)$/;
const FENCE = /^(`{3,}|~{3,})/;
const STANDALONE_IMAGE = /^[ \t]*!\[([^\]]*)\]\([ \t]*<?([^)>\s]+)>?(?:[ \t]+"[^"]*")?[ \t]*\)[ \t]*$/;
const WIKILINK_COVER = /^\[\[(.+)\]\]$/;

function parseNormalizedFrontmatter(raw: string | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of raw?.split(/\r?\n/) ?? []) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      if (listKey) (values[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rest] = pair;
    listKey = null;
    if (rest === "") {
      values[key] = [];
      listKey = key;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      values[key] = rest.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else values[key] = unquote(rest);
  }
  return values;
}

/** The display/editor keeps raw scalars and accepts only indented list items. */
function parseDisplayFrontmatter(raw: string | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of raw?.split(/\r?\n/) ?? []) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      const existing = listKey ? values[listKey] : undefined;
      if (Array.isArray(existing)) existing.push(item[1].trim());
      else if (listKey && existing === "") values[listKey] = [item[1].trim()];
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    listKey = pair[1];
    values[listKey] = pair[2].trim();
  }
  return values;
}

function parseNormalizedIngredients(lines: readonly string[]): string[] | null {
  let ingredients: string[] | null = null;
  let fenced = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\s*(```|~~~)/.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (ingredients === null) {
      if (/^##\s+Ingredients\s*$/i.test(line)) ingredients = [];
      continue;
    }
    if (/^#{1,2}\s+/.test(line)) break;
    const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(rawLine);
    if (item) ingredients.push(item[1]);
  }
  return ingredients;
}

function parseDisplayIngredients(lines: readonly string[]): string[] {
  const ingredients: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      if (active) break;
      active = DISPLAY_INGREDIENTS_HEADING.test(line);
    } else if (active && line) {
      ingredients.push(line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "").trim());
    }
  }
  return ingredients;
}

function parseDisplayDirections(lines: readonly string[]): string[] {
  const directions: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      if (active) break;
      active = DISPLAY_DIRECTIONS_HEADING.test(line);
      continue;
    }
    if (!active || !line || DISPLAY_SUBHEADING.test(line)) continue;
    const item = DISPLAY_LIST_ITEM.exec(line);
    if (item) directions.push(item[1].trim());
    else if (directions.length) directions[directions.length - 1] += ` ${line}`;
  }
  return directions;
}

function findLeadingImage(lines: readonly string[]): ParsedRecipeDocument["view"]["leadingImage"] {
  let fenced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^##\s/.test(line)) return null;
    const match = STANDALONE_IMAGE.exec(lines[index]);
    if (match) {
      return {
        src: match[2],
        alt: match[1],
        bodyWithoutImage: [...lines.slice(0, index), ...lines.slice(index + 1)].join("\n"),
      };
    }
  }
  return null;
}

function recipeMetadata(
  path: string,
  body: string,
  frontmatter: Record<string, unknown>,
  lines: readonly string[],
): ParsedRecipeDocument["recipe"] {
  const fallbackTitle = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  const headingTitle = /^#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() ?? null;
  const markdownImage = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/.exec(body);
  const wikiImage = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(body);
  const cover = cleanScalar(frontmatter.cover)
    ?? (markdownImage ? markdownImage[1] ?? markdownImage[2] : wikiImage?.[1]?.trim() ?? null);
  const tags = new Set<string>();
  const value = frontmatter.tags;
  const frontmatterTags = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  for (const tag of frontmatterTags) {
    if (typeof tag === "string" && tag.trim()) tags.add(tag.trim().replace(/^#/, ""));
  }
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(match[1]);
  return {
    title: cleanScalar(frontmatter.title) ?? headingTitle ?? fallbackTitle,
    ingredients: parseNormalizedIngredients(lines),
    cover,
    added: cleanScalar(frontmatter.added),
    tags: [...tags].sort((left, right) => left.localeCompare(right)),
  };
}

function viewMetadata(
  body: string,
  frontmatter: Record<string, unknown>,
  lines: readonly string[],
): ParsedRecipeDocument["view"] {
  const headingTitle = /^#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() ?? null;
  const frontmatterTitle = typeof frontmatter.title === "string"
    ? stripWrappedQuotes(frontmatter.title.trim()).trim()
    : "";
  const declaredCover = [frontmatter.cover, frontmatter.image]
    .map((value) => typeof value === "string" ? stripWrappedQuotes(value) : "")
    .find(Boolean) ?? "";
  const coverMatch = WIKILINK_COVER.exec(declaredCover);
  const source = presentationValue(frontmatter.source);
  const tagsValue = presentationValue(frontmatter.tags);
  const tags = (Array.isArray(tagsValue) ? tagsValue : tagsValue ? [tagsValue] : [])
    .map((tag) => String(tag).trim()).filter(Boolean);
  return {
    title: frontmatterTitle || headingTitle,
    ingredients: parseDisplayIngredients(lines),
    directions: parseDisplayDirections(lines),
    declaredCover: coverMatch ? coverMatch[1].trim() : declaredCover || null,
    leadingImage: findLeadingImage(lines),
    source: typeof source === "string" && source ? source : null,
    tags,
  };
}

/** Parses the strict catalogue and historic display projections without conflating their policies. */
export function parseRecipeDocument(path: string, markdown: string): ParsedRecipeDocument {
  try {
    const standard = parseRecipeMD(markdown);
    const parsedIngredients = flattenIngredients(standard);
    const ingredients = parsedIngredients.map(ingredient => ingredient.raw);
    const description = standard.description ?? "";
    const lines = description.split(/\r?\n/);
    const source = /(?:^|\n)Source:\s*(?:\[[^\]]*\]\(([^)]+)\)|([^\n]+))/.exec(description);
    const added = /(?:^|\n)Added:\s*(\d{4}-\d{2}-\d{2})/.exec(description)?.[1] ?? null;
    const view = viewMetadata(description, {}, lines);
    return { path, markdown, body: markdown, rawFrontmatter: null, frontmatter: {}, recipeMD: standard,
      recipe: { title: standard.title, ingredients, cover: recipeMetadata(path, description, {}, lines).cover, added, tags: standard.tags },
      view: { ...view, title: standard.title, ingredients: parsedIngredients.map(ingredientText), directions: parseDisplayDirections(['## Method', ...(standard.instructions ?? '').replace(/^##\s+(Method|Directions)\s*\n/i, '').split(/\r?\n/)]), source: source?.[1] ?? source?.[2] ?? null, tags: standard.tags } };
  } catch { /* Existing cookbooks remain readable until their explicit migration. */ }
  const recipeFrame = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  const displayFrame = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  const recipeBody = recipeFrame ? markdown.slice(recipeFrame[0].length) : markdown;
  const body = displayFrame ? markdown.slice(displayFrame[0].length) : markdown;
  const recipeRawFrontmatter = recipeFrame ? (recipeFrame[1]?.trim() ?? "") : null;
  const rawFrontmatter = displayFrame ? (displayFrame[1]?.trim() ?? "") : null;
  const normalizedFrontmatter = parseNormalizedFrontmatter(recipeRawFrontmatter);
  const frontmatter = parseDisplayFrontmatter(rawFrontmatter);
  const recipeLines = recipeBody.split(/\r?\n/);
  const displayLines = body === recipeBody ? recipeLines : body.split(/\r?\n/);
  return {
    path,
    markdown,
    body,
    rawFrontmatter,
    frontmatter,
    recipe: recipeMetadata(path, recipeBody, normalizedFrontmatter, recipeLines),
    view: viewMetadata(body, frontmatter, displayLines),
  };
}
