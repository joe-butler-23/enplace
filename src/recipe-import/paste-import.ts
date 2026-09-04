import { renderImportedRecipe } from "../core";
import { writeNewBytesBatch } from "../host-client/browser-storage";
import { createCoverFiles, thumbnailPathForCover } from "../cookbook/covers";

export type PasteRecipeInput = {
  title: string;
  source: string;
  ingredients: string;
  method: string;
  cover?: File | null;
};

const slugify = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export async function importPastedRecipe(input: PasteRecipeInput): Promise<{ markdownPath: string }> {
  const title = input.title.trim();
  const ingredients = lines(input.ingredients);
  const method = lines(input.method);
  if (!title || ingredients.length === 0 || method.length === 0) throw new Error("Title, ingredients, and method are required.");
  const slug = slugify(title);
  const markdownPath = `${slug}.md`;
  const coverPath = input.cover && input.cover.size > 0 ? `images/${slug}.webp` : undefined;
  const encoder = new TextEncoder();
  const entries: Array<readonly [string, Uint8Array]> = [[
    markdownPath,
    encoder.encode(renderImportedRecipe({ title, ingredients, method, source: input.source, cover: coverPath })),
  ]];
  if (coverPath && input.cover) {
    const files = await createCoverFiles(input.cover);
    entries.push([coverPath, files.cover], [thumbnailPathForCover(coverPath), files.thumbnail]);
  }
  await writeNewBytesBatch(entries, "reject");
  return { markdownPath };
}
