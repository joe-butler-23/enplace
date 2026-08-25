import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

vi.mock("@/host-client/fs", () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  exists: vi.fn(),
  stat: vi.fn()
}));
vi.mock("@/host-client/path", () => ({
  appDataDir: vi.fn(),
  join: vi.fn()
}));

describe("FileManager.processFrontMatter", () => {
  it("serializes concurrent updates to the same file", async () => {
    const { FileManager, TFile } = await import("./platform");
    let content = "---\ntitle: Recipe\n---\n\n# Recipe\n";
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWriteReleased = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteObserved = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const file = new TFile("recipes/recipe.md", "recipe.md", "/vault/recipes/recipe.md", {
      mtime: 0,
      size: content.length
    });
    let writeCount = 0;
    const vault = {
      read: vi.fn(async () => content),
      modify: vi.fn(async (_file: TFile, next: string) => {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted();
          await firstWriteReleased;
        }
        content = next;
      })
    };
    const app = {
      vault,
      metadataCache: {}
    };
    const manager = new FileManager(app as never);

    const first = manager.processFrontMatter(file, (frontmatter) => {
      frontmatter.scheduled = ["2026-07-14"];
    });
    const second = manager.processFrontMatter(file, (frontmatter) => {
      frontmatter.scheduled = [
        ...(Array.isArray(frontmatter.scheduled) ? frontmatter.scheduled : []),
        "2026-07-15"
      ];
    });

    await firstWriteObserved;
    await Promise.resolve();
    expect(vault.read).toHaveBeenCalledTimes(1);
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(content).toContain("- 2026-07-14");
    expect(content).toContain("- 2026-07-15");
    expect(vault.read).toHaveBeenCalledTimes(2);
  });

  it("round-trips nested values and block scalars while updating frontmatter", async () => {
    const { FileManager, TFile } = await import("./platform");
    let content = [
      "---",
      "title: Recipe",
      "metadata:",
      "  source:",
      "    publisher: Example Kitchen",
      "    url: https://example.test/recipe",
      "notes: |",
      "  Keep the sauce warm.",
      "  Do not boil.",
      "tags:",
      "  - dinner",
      "  - quick",
      "---",
      "",
      "# Recipe",
      ""
    ].join("\n");
    const file = new TFile("recipes/recipe.md", "recipe.md", "/vault/recipes/recipe.md", {
      mtime: 0,
      size: content.length
    });
    const vault = {
      read: vi.fn(async () => content),
      modify: vi.fn(async (_file: TFile, next: string) => {
        content = next;
      })
    };
    const manager = new FileManager({ vault, metadataCache: {} } as never);

    await manager.processFrontMatter(file, (frontmatter) => {
      frontmatter.marked = true;
    });

    const yamlBlock = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    expect(yamlBlock).toBeTruthy();
    expect(parseYaml(yamlBlock ?? "")).toEqual({
      title: "Recipe",
      metadata: {
        source: {
          publisher: "Example Kitchen",
          url: "https://example.test/recipe"
        }
      },
      notes: "Keep the sauce warm.\nDo not boil.\n",
      tags: ["dinner", "quick"],
      marked: true
    });
  });
});
