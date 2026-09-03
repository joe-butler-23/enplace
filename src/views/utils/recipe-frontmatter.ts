export type FrontmatterParseResult = {
  frontmatter: Record<string, unknown>;
  body: string;
  rawFrontmatter: string | null;
};

export function parseFrontmatter(content: string): FrontmatterParseResult {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: content, rawFrontmatter: null };
  }
  const block = match[1]?.trim() ?? "";
  const body = content.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const line of block.split(/\r?\n/)) {
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey) {
      const existing = frontmatter[currentKey];
      if (Array.isArray(existing)) {
        existing.push(listMatch[1].trim());
      } else if (existing === "") {
        frontmatter[currentKey] = [listMatch[1].trim()];
      }
      continue;
    }

    const lineMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!lineMatch) continue;
    const [, key, value] = lineMatch;
    currentKey = key;
    frontmatter[key] = value.trim();
  }

  return { frontmatter, body, rawFrontmatter: block };
}

const DIRECTIONS_HEADING = /^##\s+(Directions|Method)\b/i;
const SUBHEADING = /^#{3,6}\s/;
const LIST_ITEM = /^(?:\d+\.|[-*+])\s+(.*)$/;

export function parseDirectionsSection(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inSection) break;
      if (DIRECTIONS_HEADING.test(line)) inSection = true;
      continue;
    }
    if (!inSection || !line) continue;
    if (SUBHEADING.test(line)) continue; // a subheading inside Method is not a step

    const listMatch = line.match(LIST_ITEM);
    if (listMatch) {
      items.push(listMatch[1].trim());
    } else if (items.length > 0) {
      // A wrapped continuation line folds into the step it belongs to.
      items[items.length - 1] = `${items[items.length - 1]} ${line}`;
    }
  }

  return items;
}

export function stripWrappedQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeFrontmatterValue(value: unknown): unknown {
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
    if (!inner) return [];
    return inner
      .split(",")
      .map((entry) => stripWrappedQuotes(entry))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (unquoted.includes(",") && !unquoted.includes("://")) {
    const entries = unquoted
      .split(",")
      .map((entry) => stripWrappedQuotes(entry))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length > 1) return entries;
  }

  return unquoted;
}

export function extractRecipeTitle(body: string, fallback: string): string {
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (!headingMatch) return fallback;
  const heading = headingMatch[1]?.trim();
  return heading || fallback;
}

export function composeMarkdown(rawFrontmatter: string | null, body: string): string {
  const normalizedBody = body.replace(/^\s+/, "").replace(/\s+$/, "");
  if (!rawFrontmatter) {
    return normalizedBody;
  }
  return `---\n${rawFrontmatter}\n---\n\n${normalizedBody}`;
}

export function stripLeadingH1(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) return markdown;

  if (lines[firstIndex].trim().startsWith("# ")) {
    lines.splice(firstIndex, 1);
    return lines.join("\n");
  }
  return markdown;
}

const STRUCTURED_HEADING = /^##\s+(Ingredients|Directions|Method|Cook Log)\b/i;
const ATX_HEADING = /^#{1,2}\s+\S/;
const SETEXT_UNDERLINE = /^(=+|-+)\s*$/;
const FENCE = /^(`{3,}|~{3,})/;

export function stripStructuredSections(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (FENCE.test(trimmed)) {
      inFence = !inFence;
      if (!skipping) kept.push(line);
      continue;
    }
    if (inFence) {
      // Content inside a fenced code block is never a heading.
      if (!skipping) kept.push(line);
      continue;
    }

    if (ATX_HEADING.test(trimmed)) {
      // Any level-1/2 heading ends a skipped section; only a structured one starts it.
      skipping = STRUCTURED_HEADING.test(trimmed);
    } else if (trimmed && SETEXT_UNDERLINE.test(lines[i + 1]?.trim() ?? "")) {
      // A setext heading also ends a skipped section.
      skipping = false;
    }

    if (!skipping) kept.push(line);
  }

  return kept.join("\n").trim();
}

const STANDALONE_IMAGE = /^[ \t]*!\[([^\]]*)\]\([ \t]*<?([^)>\s]+)>?(?:[ \t]+"[^"]*")?[ \t]*\)[ \t]*$/;
const WIKILINK_COVER = /^\[\[(.+)\]\]$/;

export type RecipeHeroImage = { src: string; alt: string };

function resolveDeclaredCover(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = stripWrappedQuotes(value);
  if (!trimmed) return null;
  const wikilink = trimmed.match(WIKILINK_COVER);
  return wikilink ? wikilink[1].trim() : trimmed;
}

/** Compares two image references written for the same file: `./images/a.webp` is `images/a%2Ewebp`. */
function isSameImageSource(a: string, b: string): boolean {
  return normalizeImageSource(a) === normalizeImageSource(b);
}

function normalizeImageSource(value: string): string {
  const trimmed = value.trim().replace(/^\.\//, "");
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** Only a block-level image before the first `##` heading, outside any fence, is eligible. */
function findLeadingStandaloneImage(
  markdown: string
): { image: RecipeHeroImage; body: string } | null {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (FENCE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s/.test(trimmed)) break;

    const match = STANDALONE_IMAGE.exec(lines[i]);
    if (match) {
      const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
      return { image: { src: match[2], alt: match[1] }, body };
    }
  }
  return null;
}

export function extractHeroImage(
  markdown: string,
  frontmatter: Record<string, unknown>
): { hero: RecipeHeroImage | null; body: string } {
  const leading = findLeadingStandaloneImage(markdown);
  const declared = resolveDeclaredCover(frontmatter.cover) ?? resolveDeclaredCover(frontmatter.image);
  if (declared) {
    // Imported recipes write the cover into the frontmatter and repeat it as the body's leading
    // image. Drop that copy so the masthead is the only place the cover renders. A leading image
    // that is a different picture is content, not a duplicate, and stays in the body.
    const body = leading && isSameImageSource(leading.image.src, declared) ? leading.body : markdown;
    return { hero: { src: declared, alt: "" }, body };
  }

  if (leading) return { hero: leading.image, body: leading.body };

  return { hero: null, body: markdown };
}

export type RecipeMeta = {
  source: { label: string; href: string | null } | null;
  tags: string[];
};

/**
 * What the masthead is allowed to say. Provenance is not derivable from the page and tags
 * close it out; everything else in the frontmatter is bookkeeping the cook already knows.
 * A step count restates the numbered list, "not yet cooked" states an absence, and a
 * scheduled date restates the planner the reader just came from.
 */
export function buildRecipeMeta(frontmatter: Record<string, unknown>): RecipeMeta {
  const rawSource = normalizeFrontmatterValue(frontmatter.source);
  let source: RecipeMeta["source"] = null;
  if (typeof rawSource === "string" && rawSource) {
    try {
      const url = new URL(rawSource);
      const isWeb = url.protocol === "http:" || url.protocol === "https:";
      const label = url.hostname.replace(/^www\./, "");
      // A scheme with no host (javascript:, data:) has nothing to show and must never be linked.
      source = label ? { label, href: isWeb ? rawSource : null } : null;
    } catch {
      // A source that is not a URL (a book, a person) is still worth showing, just not linked.
      source = { label: rawSource, href: null };
    }
  }

  const rawTags = normalizeFrontmatterValue(frontmatter.tags);
  const tags = (Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [])
    .map((tag) => String(tag).trim())
    .filter((tag) => tag.length > 0);

  return { source, tags };
}
