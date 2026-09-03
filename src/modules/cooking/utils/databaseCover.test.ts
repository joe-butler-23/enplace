import { describe, expect, it } from "vitest";
import { normalizePath } from "@/platform-primitives";
import { type DatabaseCoverResolverContext, resolveDatabaseCoverPath } from "./databaseCover";

type ResolverOptions = {
  files?: Record<string, string>;
  resolveLinkpath?: (linkpath: string, sourcePath: string) => string | null;
};

function createResolverContext(options: ResolverOptions = {}): DatabaseCoverResolverContext {
  const absoluteByPath = new Map(
    Object.entries(options.files ?? {}).map(([path, absolute]) => [normalizePath(path), absolute] as const)
  );
  return {
    findAbsolutePath: (path) => absoluteByPath.get(normalizePath(path)) ?? null,
    resolveLinkpath: options.resolveLinkpath ?? (() => null)
  };
}

describe("resolveDatabaseCoverPath", () => {
  it("resolves a cover relative to its nested recipe", () => {
    const context = createResolverContext({
      files: { "recipes/images/chipotle.webp": "/recipes/images/chipotle.webp" }
    });
    expect(resolveDatabaseCoverPath(
      "images/chipotle.webp",
      "recipes/chipotle.md",
      context
    )).toBe("/recipes/images/chipotle.webp");
  });

  it("resolves a selected-folder-relative cover directly", () => {
    const context = createResolverContext({
      files: { "images/chipotle.webp": "/images/chipotle.webp" }
    });
    expect(resolveDatabaseCoverPath(
      "/images/chipotle.webp",
      "recipes/chipotle.md",
      context
    )).toBe("/images/chipotle.webp");
  });

  it("falls back to linkpath resolution with normalized paths", () => {
    const context = createResolverContext({
      resolveLinkpath: (linkpath, sourcePath) =>
        linkpath === "images/chipotle.webp" && sourcePath === "recipes/chipotle.md"
          ? "/images/chipotle.webp"
          : null
    });
    expect(resolveDatabaseCoverPath(
      "images\\chipotle.webp",
      "recipes\\chipotle.md",
      context
    )).toBe("/images/chipotle.webp");
  });

  it("returns remote URLs unchanged", () => {
    const remote = "https://cdn.example.com/chipotle.webp";
    expect(resolveDatabaseCoverPath(remote, "recipes/chipotle.md", createResolverContext())).toBe(remote);
  });
});
