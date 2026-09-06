export type ClippedRecipe = {
  title: string;
  description: string;
  notes: string;
  nutritionInfo: string;
  /** Ordered rows; a `[Group]` row labels the rows that follow it. */
  ingredients: string[];
  /** Ordered steps; a `[Label]` row is a section or step caption, not a step. */
  instructions: string[];
  source: string;
  imageURL: string;
  yield: string;
  activeTime: string;
  cookTime: string;
  totalTime: string;
  method: "json-ld" | "json-ld+markup" | "microdata" | "markup" | "headings";
  missing: Array<"title" | "ingredients" | "instructions">;
};

/** Every distinct recipe a parsed document publishes. Synchronous, deterministic, no network. */
export function clipRecipes(doc: Document, options?: { url?: string }): ClippedRecipe[];
