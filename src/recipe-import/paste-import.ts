import { renderImportedRecipe } from "../core";
import { pathExists, writeNewBytes, writeNewText } from "../host-client/browser-storage";

export type PasteRecipeInput = {
  title: string;
  source: string;
  ingredients: string;
  method: string;
  prepTime?: string;
  cookTime?: string;
  servings?: string;
  cover?: File | null;
};

const slugify = (title: string) => title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recipe";
const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export async function importPastedRecipe(input: PasteRecipeInput): Promise<{ markdownPath: string }> {
  const title = input.title.trim();
  const ingredients = lines(input.ingredients);
  const method = lines(input.method);
  if (!title || ingredients.length === 0 || method.length === 0) throw new Error("Title, ingredients, and method are required.");
  const slug = slugify(title);
  const markdownPath = `${slug}.md`;
  const extension = input.cover?.name.includes(".") ? input.cover.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase() : null;
  const coverPath = input.cover && input.cover.size > 0 ? `images/${slug}${extension ? `.${extension}` : ""}` : undefined;
  if (await pathExists(markdownPath)) throw new Error(`A recipe named ${title} already exists.`);
  if (coverPath && await pathExists(coverPath)) throw new Error(`A cover file already exists at ${coverPath}.`);
  await writeNewText(markdownPath, renderImportedRecipe({ title, ingredients, method, source: input.source, cover: coverPath }));
  if (coverPath && input.cover) await writeNewBytes(coverPath, new Uint8Array(await input.cover.arrayBuffer()));
  window.location.reload();
  return { markdownPath };
}
