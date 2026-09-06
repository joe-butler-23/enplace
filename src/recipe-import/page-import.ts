import { formatIngredient } from "../recipe-migration";
import { parseRecipeMD } from "../recipemd";
import { importPastedRecipe } from "./paste-import";
import { clipRecipes, type ClippedRecipe } from "./recipe-clipper";

export type PageRecipe = {
  index: number;
  title: string;
  ingredientCount: number;
  instructionCount: number;
  missing: string[];
  /** RecipeMD ready to add, or null when the page's recipe cannot be rendered. */
  markdown: string | null;
  error: string | null;
};

const isLabel = (line: string): boolean => /^\[.+\]$/.test(line);
const labelText = (line: string): string => line.slice(1, -1).trim();
/** Keep description prose as prose: a line that would open a block construct is escaped. */
const proseLine = (line: string): string => line
  .replace(/^(\s*)(\d+)([.)])(?=\s|$)/, "$1$2\\$3")
  .replace(/^(\s*)([#>*+-])(?=\s|$)/, "$1\\$2")
  .replace(/^(\s*)(-{3,}|\*{3,}|_{3,})\s*$/, "$1\\$2");

export function formatDuration(value: string): string {
  const text = value.trim();
  const iso = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(text);
  if (!iso) return text;
  const parts = ([[iso[1], "d"], [iso[2], "h"], [iso[3], "min"], [iso[4], "s"]] as const)
    .filter(([amount]) => amount && Number(amount) > 0)
    .map(([amount, unit]) => `${Number(amount)} ${unit}`);
  return parts.join(" ") || text;
}

/** A RecipeMD yields paragraph must start with an amount; `Serves 4` and `Makes 12 muffins` are rewritten, prose is dropped. */
export function formatYield(value: string): string | null {
  const first = value.split(" / ")[0].trim();
  if (!first) return null;
  if (/^\d/.test(first)) return first;
  const match = /^(?:serves|makes|yields?|for)\s+(\d[\d.,]*(?:\s*[-–]\s*\d[\d.,]*)?)\s*(.*)$/i.exec(first);
  return match ? `${match[1]} ${match[2] || "servings"}`.trim() : null;
}

export function pageRecipeMarkdown(recipe: ClippedRecipe, pageUrl: string): string {
  const title = recipe.title.trim() || "Untitled recipe";
  const description: string[] = [];
  if (recipe.imageURL) description.push(`![${title}](<${recipe.imageURL}>)`);
  const source = recipe.source || pageUrl.trim();
  if (source) description.push(`Source: ${source}`);
  if (recipe.description.trim()) description.push(recipe.description.trim().split("\n").map(proseLine).join("\n"));
  const times = ([["Prep", recipe.activeTime], ["Cook", recipe.cookTime], ["Total", recipe.totalTime]] as const)
    .filter(([, value]) => value.trim()).map(([name, value]) => `${name} ${formatDuration(value)}`);
  if (times.length) description.push(times.join(" · "));
  const yields = formatYield(recipe.yield);
  const ingredients = recipe.ingredients.map((line) => isLabel(line) ? `\n## ${labelText(line)}\n` : `- ${formatIngredient(line)}`);
  let step = 0;
  const instructions = recipe.instructions.map((line) => isLabel(line) ? `\n### ${labelText(line)}\n` : `${++step}. ${line.trim().replace(/^\d+[.)]\s*/, "")}`);
  const sections = [
    `# ${title}`,
    description.join("\n\n"),
    yields ? `**${yields}**` : "",
    "---",
    ingredients.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    "---",
    instructions.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    recipe.notes.trim() ? `## Notes\n\n${recipe.notes.trim().split("\n").map(proseLine).join("\n")}` : "",
    recipe.nutritionInfo.trim() ? `## Nutrition\n\n${recipe.nutritionInfo.trim().split("\n").map((line) => `- ${line}`).join("\n")}` : "",
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

/** Every recipe the page publishes, rendered as RecipeMD or carrying the reason it cannot be. */
export function readPageRecipes(html: string, pageUrl: string): PageRecipe[] {
  const url = pageUrl.trim();
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Always pass the address, even empty: the parsed document otherwise inherits this app's own URL,
  // whose fragment is the cookbook secret, and it would become the recipe's source.
  return clipRecipes(doc, { url }).map((recipe, index) => {
    const base = {
      index, title: recipe.title || "Untitled recipe",
      ingredientCount: recipe.ingredients.filter((line) => !isLabel(line)).length,
      instructionCount: recipe.instructions.filter((line) => !isLabel(line)).length,
      missing: recipe.missing,
    };
    try {
      const markdown = pageRecipeMarkdown(recipe, url);
      parseRecipeMD(markdown);
      return { ...base, markdown, error: null };
    } catch (error) {
      return { ...base, markdown: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export type PageImportResult = { title: string; path: string | null; error: string | null };

/** Adds each chosen recipe as a new cookbook file; an existing file is never overwritten. */
export async function importPageRecipes(recipes: readonly PageRecipe[]): Promise<PageImportResult[]> {
  const results: PageImportResult[] = [];
  for (const recipe of recipes) {
    if (!recipe.markdown) { results.push({ title: recipe.title, path: null, error: recipe.error ?? "This recipe is incomplete." }); continue; }
    try {
      const added = await importPastedRecipe({ markdown: recipe.markdown });
      results.push({ title: added.title, path: added.markdownPath, error: null });
    } catch (error) {
      results.push({ title: recipe.title, path: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
