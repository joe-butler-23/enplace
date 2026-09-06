// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
const { createCoverFiles } = vi.hoisted(() => ({ createCoverFiles: vi.fn() }));
vi.mock("../cookbook/covers", async (importOriginal) => ({ ...(await importOriginal<typeof import("../cookbook/covers")>()), createCoverFiles }));
import { newCookbookId, readCookbookText, writeCookbookText } from "../cookbook/doc";
import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { setCurrentCookbookConnection } from "../cookbook/current";
import { parseRecipeMD, flattenIngredients } from "../recipemd";
import { formatDuration, formatYield, importPageRecipes, pageRecipeMarkdown, readPageRecipes } from "./page-import";
import type { ClippedRecipe } from "./recipe-clipper";

const clipped = (overrides: Partial<ClippedRecipe> = {}): ClippedRecipe => ({
  title: "Watermelon gazpacho", description: "", notes: "", nutritionInfo: "",
  ingredients: ["[For the gazpacho]", "250g watermelon flesh, roughly chopped", "3.0tbsp sherry vinegar", "[For the salsa]", "Fine sea salt"],
  instructions: ["[Step 1]", "Blitz everything.", "Chill for 2 hours."],
  source: "https://example.test/soups", imageURL: "https://example.test/soup.jpg", yield: "Serves 4.0",
  activeTime: "PT20M", cookTime: "", totalTime: "PT1H30M", method: "json-ld", missing: [], ...overrides,
});

const jsonLd = (recipes: object[]): string => `<!doctype html><html><head><title>Two soups</title>
  <script type="application/ld+json">${JSON.stringify(recipes).replaceAll("<", "\\u003c")}</script></head><body><h1>Two soups</h1></body></html>`;
const recipe = (name: string, ingredients: string[]) => ({
  "@context": "https://schema.org", "@type": "Recipe", name, recipeIngredient: ingredients, recipeYield: "2 servings",
  recipeInstructions: [{ "@type": "HowToStep", text: "Blend." }, { "@type": "HowToStep", text: "Serve cold." }],
});

const connections: CookbookConnection[] = [];
afterEach(async () => {
  setCurrentCookbookConnection(null);
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});
async function emptyCookbook(): Promise<CookbookConnection> {
  const connection = await openCookbook({ id: newCookbookId(), relayUrl: null, persist: false });
  connections.push(connection);
  setCurrentCookbookConnection(connection);
  return connection;
}

describe("page recipe Markdown", () => {
  it("renders groups, captions, provenance, times and yields as RecipeMD", () => {
    const markdown = pageRecipeMarkdown(clipped(), "https://example.test/page");
    const parsed = parseRecipeMD(markdown);
    expect(parsed.title).toBe("Watermelon gazpacho");
    expect(parsed.description).toContain("Source: https://example.test/soups");
    expect(parsed.description).not.toContain("soup.jpg");
    expect(parsed.description).toContain("Prep 20 min · Total 1 h 30 min");
    expect(parsed.yields).toEqual([{ factor: "4", unit: "servings" }]);
    expect(parsed.ingredient_groups.map((group) => group.title)).toEqual(["For the gazpacho", "For the salsa"]);
    expect(flattenIngredients(parsed).map((item) => item.raw)).toEqual(["*250 g* watermelon flesh, roughly chopped", "*3.0 tbsp* sherry vinegar", "Fine sea salt"]);
    expect(parsed.instructions).toBe("### Step 1\n\n1. Blitz everything.\n2. Chill for 2 hours.");
  });
  it("keeps description prose from opening headings, lists or dividers", () => {
    const markdown = pageRecipeMarkdown(clipped({ description: "# Not a title\n- not an item\n---", notes: "1. not a step" }), "");
    const parsed = parseRecipeMD(markdown);
    expect(parsed.description).toContain("\\# Not a title");
    expect(parsed.ingredients.length + parsed.ingredient_groups.length).toBe(2);
    expect(parsed.instructions).toContain("## Notes\n\n1\\. not a step");
  });
  it("formats durations and yields conservatively", () => {
    expect(formatDuration("PT45M")).toBe("45 min");
    expect(formatDuration("P1DT2H")).toBe("1 d 2 h");
    expect(formatDuration("about an hour")).toBe("about an hour");
    expect(formatYield("Serves 4")).toBe("4 servings");
    expect(formatYield("Makes 12 muffins")).toBe("12 muffins");
    expect(formatYield("4 servings / 4")).toBe("4 servings");
    expect(formatYield("A crowd")).toBeNull();
  });
});

describe("reading a page", () => {
  it("lists every recipe a page publishes and renders each", () => {
    const page = jsonLd([recipe("Cucumber soup", ["1 cucumber", "100g yoghurt"]), recipe("Tomato gazpacho", ["800g tomatoes"])]);
    const found = readPageRecipes(page, "https://example.test/two-soups");
    expect(found.map((item) => [item.title, item.ingredientCount, item.instructionCount, item.error])).toEqual([
      ["Cucumber soup", 2, 2, null], ["Tomato gazpacho", 1, 2, null],
    ]);
    expect(found[0].markdown).toContain("Source: https://example.test/two-soups");
    expect(parseRecipeMD(found[1].markdown!).yields).toEqual([{ factor: "2", unit: "servings" }]);
  });
  it("never records this app's own address as a source when no page address is given", () => {
    const before = window.location.href;
    window.history.replaceState(null, "", "/#k=e1_secretcookbookkey");
    try {
      const [found] = readPageRecipes(jsonLd([recipe("Plain soup", ["1 leek"])]), "");
      expect(found.markdown).not.toContain("Source:");
      expect(found.markdown).not.toContain("secretcookbookkey");
    } finally { window.history.replaceState(null, "", before); }
  });
  it("reports an incomplete recipe instead of rendering it silently", () => {
    const [found] = readPageRecipes(jsonLd([{ "@type": "Recipe", name: "Only a name" }]), "");
    expect(found.missing).toEqual(["ingredients", "instructions"]);
    expect(found.markdown).not.toBeNull();
  });
  it("returns nothing for a page without recipes", () => {
    expect(readPageRecipes("<!doctype html><p>Hello</p>", "")).toEqual([]);
  });
});

describe("importing chosen recipes", () => {
  it("adds each chosen recipe once and never overwrites an existing file", async () => {
    const connection = await emptyCookbook();
    writeCookbookText(connection.doc, "tomato-gazpacho.md", "# Tomato gazpacho\n\n---\n\n- *1* tomato\n\n---\n\n1. Keep me.\n");
    const found = readPageRecipes(jsonLd([recipe("Cucumber soup", ["1 cucumber"]), recipe("Tomato gazpacho", ["800g tomatoes"])]), "");
    const results = await importPageRecipes(found);
    expect(results[0]).toEqual({ title: "Cucumber soup", path: "cucumber-soup.md", error: null, cover: false });
    expect(results[1].path).toBeNull();
    expect(results[1].error).toContain("already exists");
    expect(readCookbookText(connection.doc, "tomato-gazpacho.md")).toContain("Keep me.");
    expect(readCookbookText(connection.doc, "cucumber-soup.md")).toContain("- *1* cucumber");
  });
  it("skips an unrenderable recipe with its reason", async () => {
    await emptyCookbook();
    const results = await importPageRecipes([{ index: 0, title: "Broken", ingredientCount: 0, instructionCount: 0, missing: [], markdown: null, error: "Invalid RecipeMD amount: x", imageUrl: "" }]);
    expect(results).toEqual([{ title: "Broken", path: null, error: "Invalid RecipeMD amount: x", cover: false }]);
  });
  it("stores the page's picture as the cover, and adds the recipe without one when the picture cannot be had or stored", async () => {
    const connection = await emptyCookbook();
    createCoverFiles.mockReset().mockResolvedValue({ cover: new Uint8Array([4, 5]), thumbnail: new Uint8Array([6]) });
    const page = jsonLd([{ ...recipe("Pea soup", ["1 pea"]), image: "https://example.test/pea.jpg" }, { ...recipe("Bean soup", ["1 bean"]), image: "https://example.test/bean.jpg" }, recipe("Plain soup", ["1 leek"])]);
    const found = readPageRecipes(page, "https://example.test/soups");
    expect(found.map((item) => item.imageUrl)).toEqual(["https://example.test/pea.jpg", "https://example.test/bean.jpg", ""]);
    const fetched: string[] = [];
    const results = await importPageRecipes(found, async (url) => { fetched.push(url); return url.endsWith("pea.jpg") ? new Blob([new Uint8Array([1, 2])], { type: "image/jpeg" }) : null; });
    expect(fetched).toEqual(["https://example.test/pea.jpg", "https://example.test/bean.jpg"]);
    expect(results.map((result) => [result.path, result.cover, result.error])).toEqual([["pea-soup.md", true, null], ["bean-soup.md", false, null], ["plain-soup.md", false, null]]);
    expect(readCookbookText(connection.doc, "pea-soup.md")).toContain("![Pea soup](<images/pea-soup.webp>)");
    expect(readCookbookText(connection.doc, "bean-soup.md")).not.toContain("images/");
    createCoverFiles.mockReset().mockRejectedValue(new Error("This browser could not encode the cover image as WebP."));
    const again = await importPageRecipes(readPageRecipes(jsonLd([{ ...recipe("Corn soup", ["1 cob"]), image: "https://example.test/corn.jpg" }]), ""), async () => new Blob([new Uint8Array([1])], { type: "image/jpeg" }));
    expect(again).toEqual([{ title: "Corn soup", path: "corn-soup.md", error: null, cover: false }]);
    expect(readCookbookText(connection.doc, "corn-soup.md")).not.toContain("images/");
  });
});
