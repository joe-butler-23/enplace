import { normalizePath } from "@/platform";

const REMOTE_IMAGE_RE = /^(https?:|data:|blob:|file:|asset:)/i;

export type DatabaseCoverResolverContext = {
  imagesFolder: string;
  recipesFolder: string;
  findAbsolutePath: (vaultPath: string) => string | null;
  resolveLinkpath: (linkpath: string, sourcePath: string) => string | null;
};

function normalizeCoverPath(value: string): string {
  return normalizePath(value.replace(/^\.\//, ""));
}

export function resolveDatabaseCoverPath(
  coverPath: string | null | undefined,
  sourcePath: string,
  context: DatabaseCoverResolverContext
): string | null {
  if (!coverPath) return null;

  const trimmedCover = coverPath.trim();
  if (!trimmedCover) return null;
  if (REMOTE_IMAGE_RE.test(trimmedCover)) return trimmedCover;

  const normalizedCover = normalizeCoverPath(trimmedCover);
  if (!normalizedCover) return null;

  const normalizedSourcePath = normalizePath(sourcePath);
  const normalizedImagesFolder = normalizePath(context.imagesFolder ?? "");
  const normalizedRecipesFolder = normalizePath(context.recipesFolder ?? "");

  const tried = new Set<string>();
  const tryFind = (candidate: string): string | null => {
    const normalized = normalizePath(candidate);
    if (!normalized || tried.has(normalized)) return null;
    tried.add(normalized);
    return context.findAbsolutePath(normalized);
  };

  const direct = tryFind(normalizedCover);
  if (direct) return direct;

  if (normalizedCover.startsWith("images/") && normalizedImagesFolder) {
    const relativeToImages = normalizedCover.slice("images/".length);
    const imagesCandidate = tryFind(`${normalizedImagesFolder}/${relativeToImages}`);
    if (imagesCandidate) return imagesCandidate;

    if (
      normalizedRecipesFolder &&
      normalizedImagesFolder.startsWith(`${normalizedRecipesFolder}/`)
    ) {
      const recipesCandidate = tryFind(`${normalizedRecipesFolder}/${normalizedCover}`);
      if (recipesCandidate) return recipesCandidate;
    }
  }

  if (!normalizedCover.includes("/") && normalizedImagesFolder) {
    const imagesCandidate = tryFind(`${normalizedImagesFolder}/${normalizedCover}`);
    if (imagesCandidate) return imagesCandidate;
  }

  const sourceParent = normalizedSourcePath.split("/").slice(0, -1).join("/");
  if (sourceParent) {
    const siblingCandidate = tryFind(`${sourceParent}/${normalizedCover}`);
    if (siblingCandidate) return siblingCandidate;
  }

  const normalizedLinkpath = context.resolveLinkpath(normalizedCover, normalizedSourcePath);
  if (normalizedLinkpath) return normalizedLinkpath;

  if (trimmedCover !== normalizedCover) {
    return context.resolveLinkpath(trimmedCover, normalizedSourcePath);
  }

  return null;
}
