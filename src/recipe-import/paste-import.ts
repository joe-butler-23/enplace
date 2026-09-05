import { parseRecipe } from "../core";
import { writeNewBytesBatch } from "../host-client/browser-storage";
import { createCoverFiles, thumbnailPathForCover } from "../cookbook/covers";

export type PasteRecipeInput = {
  markdown: string;
  cover?: File | null;
};

export const RECIPE_REJECTION_MESSAGE = "This Markdown does not look like a recipe. Include a recipe title and ingredients.";

const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";

function addCover(markdown: string, title: string, coverPath: string): string {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
  const heading = /^#\s+.+?\s*$/m.exec(markdown);
  const index = frontmatter?.[0].length ?? (heading ? heading.index + heading[0].length : 0);
  return `${markdown.slice(0, index)}\n\n![${title}](<${coverPath}>)${markdown.slice(index)}`;
}

export async function importPastedRecipe(input: PasteRecipeInput): Promise<{
  markdownPath: string;
  title: string;
  ingredientCount: number;
}> {
  const recipe = parseRecipe("-", input.markdown);
  if (!recipe || recipe.title === "-") throw new Error(RECIPE_REJECTION_MESSAGE);
  const slug = slugify(recipe.title);
  const markdownPath = `${slug}.md`;
  const coverPath = input.cover && input.cover.size > 0 ? `images/${slug}.webp` : undefined;
  const markdown = coverPath ? addCover(input.markdown, recipe.title, coverPath) : input.markdown;
  const entries: Array<readonly [string, Uint8Array]> = [[markdownPath, new TextEncoder().encode(markdown)]];
  if (coverPath && input.cover) {
    const files = await createCoverFiles(input.cover);
    entries.push([coverPath, files.cover], [thumbnailPathForCover(coverPath), files.thumbnail]);
  }
  await writeNewBytesBatch(entries, "reject");
  return { markdownPath, title: recipe.title, ingredientCount: recipe.ingredients.length };
}
