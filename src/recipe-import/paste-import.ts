import { renderImportedRecipe } from "../core";
import { writeNewBytesBatch } from "../host-client/browser-storage";

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
  const extension = input.cover?.name.includes(".") ? input.cover.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() : null;
  const coverPath = input.cover && input.cover.size > 0 ? `images/${slug}${extension ? `.${extension}` : ""}` : undefined;
  const encoder = new TextEncoder();
  const entries: Array<readonly [string, Uint8Array]> = [[
    markdownPath,
    encoder.encode(renderImportedRecipe({ title, ingredients, method, source: input.source, cover: coverPath })),
  ]];
  if (coverPath && input.cover) entries.push([coverPath, new Uint8Array(await input.cover.arrayBuffer())]);
  await writeNewBytesBatch(entries, "reject");
  return { markdownPath };
}
