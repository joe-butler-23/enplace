import { describe, expect, it } from "vitest";
import { normalizePath } from "@/platform";
import {
  DatabaseCoverResolverContext,
  resolveDatabaseCoverPath
} from "./databaseCover";

type ResolverOptions = {
  files?: Record<string, string>;
  resolveLinkpath?: (linkpath: string, sourcePath: string) => string | null;
};

function createResolverContext(options: ResolverOptions = {}): DatabaseCoverResolverContext {
  const files = options.files ?? {};
  const absoluteByPath = new Map(
    Object.entries(files).map(([path, absolute]) => [normalizePath(path), absolute] as const)
  );

  return {
    imagesFolder: "recipes/images",
    recipesFolder: "recipes",
    findAbsolutePath: (path) => absoluteByPath.get(normalizePath(path)) ?? null,
    resolveLinkpath: options.resolveLinkpath ?? (() => null)
  };
}

describe("resolveDatabaseCoverPath", () => {
  it("normalizes windows separators for direct cover paths", () => {
    const context = createResolverContext({
      files: {
        "recipes/images/chipotle.webp": "C:/vault/recipes/images/chipotle.webp"
      }
    });

    const resolved = resolveDatabaseCoverPath(
      "recipes\\images\\chipotle.webp",
      "recipes\\chipotle.md",
      context
    );

    expect(resolved).toBe("C:/vault/recipes/images/chipotle.webp");
  });

  it("resolves images/ prefixed paths through configured images folder", () => {
    const context = createResolverContext({
      files: {
        "recipes/images/chipotle.webp": "C:/vault/recipes/images/chipotle.webp"
      }
    });

    const resolved = resolveDatabaseCoverPath(
      "images/chipotle.webp",
      "recipes\\chipotle.md",
      context
    );

    expect(resolved).toBe("C:/vault/recipes/images/chipotle.webp");
  });

  it("resolves bare filenames through configured images folder", () => {
    const context = createResolverContext({
      files: {
        "recipes/images/chipotle.webp": "C:/vault/recipes/images/chipotle.webp"
      }
    });

    const resolved = resolveDatabaseCoverPath(
      "chipotle.webp",
      "recipes/chipotle.md",
      context
    );

    expect(resolved).toBe("C:/vault/recipes/images/chipotle.webp");
  });

  it("falls back to linkpath resolver with normalized source path", () => {
    const context = createResolverContext({
      resolveLinkpath: (linkpath, sourcePath) => {
        if (linkpath === "images/chipotle.webp" && sourcePath === "recipes/chipotle.md") {
          return "C:/vault/recipes/images/chipotle.webp";
        }
        return null;
      }
    });

    const resolved = resolveDatabaseCoverPath(
      "images\\chipotle.webp",
      "recipes\\chipotle.md",
      context
    );

    expect(resolved).toBe("C:/vault/recipes/images/chipotle.webp");
  });

  it("returns remote URLs unchanged", () => {
    const context = createResolverContext();
    const remote = "https://cdn.example.com/chipotle.webp";

    const resolved = resolveDatabaseCoverPath(remote, "recipes/chipotle.md", context);

    expect(resolved).toBe(remote);
  });
});
