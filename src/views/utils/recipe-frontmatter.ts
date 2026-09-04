import type { ParsedRecipeDocument } from "@/recipe-document";

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
    } else if (!inFence && ATX_HEADING.test(trimmed)) {
      // Any level-1/2 heading ends a skipped section; only a structured one starts it.
      skipping = STRUCTURED_HEADING.test(trimmed);
    } else if (!inFence && trimmed && SETEXT_UNDERLINE.test(lines[i + 1]?.trim() ?? "")) {
      // A setext heading also ends a skipped section.
      skipping = false;
    }

    if (!skipping) kept.push(line);
  }

  return kept.join("\n").trim();
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

export type RecipeHeroImage = { src: string; alt: string };

export function extractHeroImage(
  parsed: ParsedRecipeDocument,
  markdown = parsed.body,
): { hero: RecipeHeroImage | null; body: string } {
  const { declaredCover, leadingImage } = parsed.view;
  if (declaredCover) {
    const body = leadingImage && isSameImageSource(leadingImage.src, declaredCover)
      ? leadingImage.bodyWithoutImage
      : markdown;
    return { hero: { src: declaredCover, alt: "" }, body };
  }
  if (leadingImage) {
    return {
      hero: { src: leadingImage.src, alt: leadingImage.alt },
      body: leadingImage.bodyWithoutImage,
    };
  }
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
export function buildRecipeMeta(parsed: ParsedRecipeDocument): RecipeMeta {
  const rawSource = parsed.view.source;
  let source: RecipeMeta["source"] = null;
  if (rawSource) {
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
  return { source, tags: parsed.view.tags };
}
