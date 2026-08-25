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

export function parseDirectionsSection(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inSection) break;
      if (/^##\s+(Directions|Method)\b/i.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    if (!line) continue;

    const cleaned = line
      .replace(/^\d+\.\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .trim();
    if (cleaned) items.push(cleaned);
  }

  return items;
}

export function formatPropertyLabel(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

export function normalizeFrontmatterValue(value: unknown): unknown {
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

export function formatPropertyValue(key: string, value: unknown): string {
  const normalized = normalizeFrontmatterValue(value);
  if (key === "source" && typeof normalized === "string") {
    try {
      const url = new URL(normalized);
      return url.hostname.replace(/^www\./, "");
    } catch {
      return normalized;
    }
  }

  if (Array.isArray(normalized)) {
    return normalized.join(" • ");
  }
  if (typeof normalized === "boolean") {
    return normalized ? "Yes" : "No";
  }
  if (normalized === null) {
    return "None";
  }
  return String(normalized);
}

export function getPropertyHref(key: string, value: unknown): string | null {
  const normalized = normalizeFrontmatterValue(value);
  if (key === "source" && typeof normalized === "string" && /^https?:\/\//.test(normalized)) {
    return normalized;
  }
  return null;
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
