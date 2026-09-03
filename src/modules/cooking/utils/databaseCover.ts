import { normalizePath } from "@/platform-primitives";
import { resolveRelativePath } from "@/core";

const REMOTE_IMAGE_RE = /^(https?:|data:|blob:|file:|asset:)/i;

export type DatabaseCoverResolverContext = {
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

  const tried = new Set<string>();
  const tryFind = (candidate: string): string | null => {
    const normalized = normalizePath(candidate);
    if (!normalized || tried.has(normalized)) return null;
    tried.add(normalized);
    return context.findAbsolutePath(normalized);
  };

  const relative = resolveRelativePath(normalizedSourcePath, trimmedCover);
  if (relative && !REMOTE_IMAGE_RE.test(relative)) {
    const relativeMatch = tryFind(relative);
    if (relativeMatch) return relativeMatch;
  }

  const direct = tryFind(normalizedCover);
  if (direct) return direct;

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
