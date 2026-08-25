import { App, normalizePath, TFile } from "@/platform";
import { CookingAssistantSettings } from "../../../settings";
import { CachedRecipe } from "../types";

export function isTruthyMarked(value: unknown): boolean {
  return value === true || value === "true" || value === "yes";
}

export function parseDateString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function parseDateTimestamp(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function isRemoteUrl(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:")
  );
}

export function normalizeTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.flatMap((tag) => {
      const normalized = tag.replace(/^#/, "").trim().toLowerCase();
      return normalized ? [normalized] : [];
    }))
  );
}

export function parseTagString(value: string): string[] {
  return value.split(/[,;\n]/).flatMap((tag) => {
    const trimmed = tag.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function resolveCoverPath(
  coverValue: unknown,
  filePath: string,
  settings: CookingAssistantSettings,
  app: App
): string | null {
  if (!coverValue) return null;
  const cover = String(coverValue).trim();
  if (!cover) return null;
  if (isRemoteUrl(cover)) return cover;

  const normalized = normalizePath(cover.replace(/^\.\//, ""));
  const recipesFolder = normalizePath(settings.recipesFolder);
  const imagesFolder = normalizePath(settings.imagesFolder);

  if (normalized.startsWith(`${recipesFolder}/`)) return normalized;
  if (normalized.startsWith(`${imagesFolder}/`)) return normalized;

  if (normalized.startsWith("images/") && imagesFolder) {
    const relative = normalized.slice("images/".length);
    const candidate = normalizePath(`${imagesFolder}/${relative}`);
    if (app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
    if (imagesFolder.startsWith(`${recipesFolder}/`)) {
      return normalizePath(`${recipesFolder}/${normalized}`);
    }
  }

  if (!normalized.includes("/") && imagesFolder) {
    const candidate = normalizePath(`${imagesFolder}/${normalized}`);
    if (app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
  }

  const parent = filePath.split("/").slice(0, -1).join("/");
  return parent ? normalizePath(`${parent}/${normalized}`) : normalized;
}

function extractTags(frontmatter: Record<string, unknown>, cacheTags?: string[]): string[] {
  const tags: string[] = [];
  const frontmatterTags = frontmatter.tags;
  if (Array.isArray(frontmatterTags)) {
    tags.push(...frontmatterTags.map((tag) => String(tag)));
  } else if (typeof frontmatterTags === "string") {
    tags.push(...parseTagString(frontmatterTags));
  }

  if (cacheTags?.length) {
    tags.push(...cacheTags);
  }

  return Array.from(new Set(tags.flatMap((tag) => {
    const normalized = tag.replace(/^#/, "");
    return normalized ? [normalized] : [];
  })));
}

function buildRecipeEntry(
  file: TFile,
  fingerprint: string,
  app: App,
  settings: CookingAssistantSettings
): CachedRecipe {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter ?? {};

  const title = String(frontmatter.title ?? file.basename).trim() || file.basename;
  const coverPath = resolveCoverPath(
    frontmatter.cover ?? frontmatter.image ?? "",
    file.path,
    settings,
    app
  );
  const marked = isTruthyMarked(frontmatter.marked);
  const added = parseDateString(frontmatter.added);
  const scheduled = parseDateString(frontmatter.scheduled);
  const tags = extractTags(frontmatter, cache?.tags);

  return {
    path: file.path,
    title,
    coverPath,
    marked,
    added,
    scheduled,
    addedTimestamp: parseDateTimestamp(added),
    scheduledTimestamp: parseDateTimestamp(scheduled),
    tags,
    fingerprint,
    titleLower: title.toLowerCase(),
    tagsLower: normalizeTags(tags)
  };
}
