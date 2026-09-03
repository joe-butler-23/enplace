import { describe, expect, it } from "vitest";
import {
  buildRecipeMeta,
  composeMarkdown,
  extractHeroImage,
  stripStructuredSections,
  extractRecipeTitle,
  parseDirectionsSection,
  parseFrontmatter,
  stripLeadingH1
} from "./recipe-frontmatter";

describe("recipe frontmatter utilities", () => {
  it("parses frontmatter blocks and preserves raw content", () => {
    const input = [
      "---",
      "title: \"Pasta\"",
      "tags: [one, \"two\"]",
      "---",
      "# Pasta",
      "",
      "Body"
    ].join("\n");

    const parsed = parseFrontmatter(input);
    expect(parsed.rawFrontmatter).toBe('title: "Pasta"\ntags: [one, "two"]');
    expect(parsed.frontmatter.title).toBe('"Pasta"');
    expect(parsed.body.startsWith("# Pasta")).toBe(true);
  });

  it("parses indented block-style lists", () => {
    const parsed = parseFrontmatter([
      "---",
      "title: Pasta",
      "tags:",
      "  - one",
      "  - two",
      "---",
      "Body"
    ].join("\n"));

    expect(parsed.frontmatter.tags).toEqual(["one", "two"]);
  });

  it("extracts directions section entries", () => {
    const markdown = [
      "# Title",
      "## Directions",
      "1. Step one",
      "2. Step two",
      "",
      "## Notes",
      "- Ignore me"
    ].join("\n");
    expect(parseDirectionsSection(markdown)).toEqual(["Step one", "Step two"]);
  });

  it("folds a wrapped continuation line into the preceding step and keeps inline markdown intact", () => {
    const markdown = [
      "## Method",
      "1. Heat the **oil** and get the pan hot.",
      "   Add the [onions](https://example.com) and cook until soft.",
      "2. Stir in the spices."
    ].join("\n");

    expect(parseDirectionsSection(markdown)).toEqual([
      "Heat the **oil** and get the pan hot. Add the [onions](https://example.com) and cook until soft.",
      "Stir in the spices."
    ]);
  });

  it("does not turn a subheading inside Method into a step", () => {
    const markdown = [
      "## Method",
      "### For the sauce",
      "1. Whisk the eggs.",
      "### To finish",
      "2. Plate up."
    ].join("\n");

    expect(parseDirectionsSection(markdown)).toEqual(["Whisk the eggs.", "Plate up."]);
  });

  it("composes markdown and strips leading h1", () => {
    expect(composeMarkdown(null, "Body")).toBe("Body");
    const combined = composeMarkdown("title: Pasta", "Body");
    expect(combined.startsWith("---")).toBe(true);

    const stripped = stripLeadingH1("# Title\n\nBody");
    expect(stripped).toBe("\nBody");

    expect(extractRecipeTitle("Body", "Fallback")).toBe("Fallback");
  });

  it("hands the structured sections to the columns and leaves the rest of the body", () => {
    const body = [
      "# Soup",
      "",
      "## Ingredients",
      "- water",
      "",
      "## Method",
      "1. Boil it.",
      "",
      "## Notes",
      "Better on day two."
    ].join("\n");

    expect(stripStructuredSections(body)).toBe("# Soup\n\n## Notes\nBetter on day two.");
    // A recipe that is nothing but the two structured sections leaves no trailing region.
    expect(stripStructuredSections("## Ingredients\n- water\n\n## Directions\n1. Boil it.")).toBe("");
    // Headings outside the structured set are never swallowed by a preceding one.
    expect(stripStructuredSections("## Method\n1. Boil it.\n\n## Source\nExample")).toBe("## Source\nExample");
    // Two structured blocks strip correctly and keep the section between them.
    expect(
      stripStructuredSections(
        "## Ingredients\nA\n\n## Notes\nkeep\n\n## Ingredients\nB\n\n## Notes\nkeep2"
      )
    ).toBe("## Notes\nkeep\n\n## Notes\nkeep2");
    // CRLF input works.
    expect(stripStructuredSections("## Ingredients\r\n- water\r\n\r\n## Notes\r\nkeep")).toBe("## Notes\nkeep");
    // A sub-heading inside a structured section stays skipped.
    expect(stripStructuredSections("## Ingredients\n### Prep\n- water\n\n## Notes\nkeep")).toBe("## Notes\nkeep");
  });

  it("keeps the cook log out of the notes body, which renders it as a section of its own", () => {
    const markdown = [
      "## Ingredients",
      "- water",
      "",
      "## Notes",
      "Serve warm.",
      "",
      "## Cook Log",
      "",
      "- 2026-08-14 | rating: 4",
      "  - Notes: Halved the onion."
    ].join("\n");

    const kept = stripStructuredSections(markdown);
    expect(kept).toContain("Serve warm.");
    // Every recipe RecipeWriter creates carries a "## Cook Log" heading, so leaving it in
    // put a stray empty heading in the notes region of every imported recipe.
    expect(kept).not.toContain("Cook Log");
    expect(kept).not.toContain("Halved the onion.");
  });

  it("does not drop content after a skipped section ends at a level-1 heading", () => {
    const markdown = [
      "## Ingredients",
      "- salt",
      "",
      "# Chef's notes",
      "",
      "Rest the meat for 10 minutes before slicing."
    ].join("\n");

    expect(stripStructuredSections(markdown)).toBe(
      "# Chef's notes\n\nRest the meat for 10 minutes before slicing."
    );
  });

  it("does not let a setext heading after a skipped section swallow the rest of the body", () => {
    const markdown = ["## Method", "1. Boil.", "", "Notes", "-----", "Rest it."].join("\n");
    const result = stripStructuredSections(markdown);
    expect(result).not.toBe("");
    expect(result).toContain("Rest it.");
  });

  it("does not treat a heading inside a fenced code block as a section boundary", () => {
    const markdown = [
      "Here is the template we use:",
      "",
      "```markdown",
      "## Ingredients",
      "- one thing",
      "```",
      "",
      "Trailing prose that should survive."
    ].join("\n");

    const result = stripStructuredSections(markdown);
    expect(result).toContain("Trailing prose that should survive.");
    expect(result).toContain("```markdown");
    expect(result).toContain("## Ingredients");
    expect(result).toContain("- one thing");
  });

  it("promotes a declared cover over a body image and removes only a promoted body image", () => {
    const declared = extractHeroImage("Prose\n\n![Bowl](images/bowl.png)", { cover: "images/cover.png" });
    expect(declared.hero).toEqual({ src: "images/cover.png", alt: "" });
    expect(declared.body).toContain("![Bowl](images/bowl.png)");

    const promoted = extractHeroImage("# Soup\n\n![Bowl](images/bowl.png)\n\nServe hot.", {});
    expect(promoted.hero).toEqual({ src: "images/bowl.png", alt: "Bowl" });
    expect(promoted.body).not.toContain("images/bowl.png");
    expect(promoted.body).toContain("Serve hot.");

    // An image inside a sentence is not a hero and stays in the body.
    const inline = extractHeroImage("Serve with ![Bowl](images/bowl.png) alongside.", {});
    expect(inline.hero).toBeNull();
    expect(inline.body).toContain("images/bowl.png");

    // Reference-style images, images inside list items/blockquotes, and titles with ")" are left alone.
    expect(extractHeroImage("![a][ref]\n\n[ref]: images/bowl.png", {}).hero).toBeNull();
    expect(extractHeroImage("- ![Bowl](images/bowl.png)", {}).hero).toBeNull();
    expect(extractHeroImage("> ![Bowl](images/bowl.png)", {}).hero).toBeNull();
    const titled = extractHeroImage('![Bowl](images/bowl.png "A (nice) bowl")', {});
    expect(titled.hero).toEqual({ src: "images/bowl.png", alt: "Bowl" });

    expect(extractHeroImage("No pictures here.", {}).hero).toBeNull();
  });

  it("removes the body copy of a declared cover so the image renders only in the masthead", () => {
    // The shape every imported recipe has: `cover:` in the frontmatter, repeated as the
    // body's leading image. Rendering both put the same picture on the page twice.
    const markdown = "# Aubergine curry\n\n![Recipe Image](images/aubergine-curry.webp)\n\n## Ingredients";
    const duplicate = extractHeroImage(markdown, { cover: "images/aubergine-curry.webp" });
    expect(duplicate.hero).toEqual({ src: "images/aubergine-curry.webp", alt: "" });
    expect(duplicate.body).not.toContain("images/aubergine-curry.webp");
    expect(duplicate.body).toContain("## Ingredients");

    // The same file written two equivalent ways is still one image.
    expect(
      extractHeroImage("![Cover](./images/a%20b.webp)", { cover: "images/a b.webp" }).body
    ).not.toContain("images/a");
  });

  it("does not promote an image inside a fenced code block and leaves the fence intact", () => {
    const markdown = ["How to embed a picture:", "", "```markdown", "![alt text](example.png)", "```"].join("\n");
    const result = extractHeroImage(markdown, {});
    expect(result.hero).toBeNull();
    expect(result.body).toBe(markdown);
  });

  it("does not promote an image that appears after the first ## heading", () => {
    const markdown = [
      "# Soup",
      "",
      "Prose.",
      "",
      "## Notes",
      "",
      "The finished plate:",
      "",
      "![Plate](plate.png)"
    ].join("\n");

    const result = extractHeroImage(markdown, {});
    expect(result.hero).toBeNull();
    expect(result.body).toContain("The finished plate:");
    expect(result.body).toContain("![Plate](plate.png)");
  });

  it("falls through to image when cover is present but empty", () => {
    const result = extractHeroImage("Body", { cover: "", image: "photos/chilli.jpg" });
    expect(result.hero).toEqual({ src: "photos/chilli.jpg", alt: "" });
  });

  it("resolves an Obsidian wiki-link cover", () => {
    const result = extractHeroImage("Body", { cover: "[[chilli.png]]" });
    expect(result.hero).toEqual({ src: "chilli.png", alt: "" });
  });

  it("shows provenance and tags, and nothing else the page already says", () => {
    const meta = buildRecipeMeta({
      title: '"Beef Chilli"',
      type: "recipe",
      marked: false,
      cooked: false,
      added: "2026-04-29",
      scheduled: "2026-05-02",
      source: "https://www.example.com/chilli",
      tags: ["quick", "batch"]
    });

    expect(meta.source).toEqual({ label: "example.com", href: "https://www.example.com/chilli" });
    expect(meta.tags).toEqual(["quick", "batch"]);
    // A step count restates the numbered list, and added/scheduled/cooked/type/marked are
    // bookkeeping the cook does not need mid-recipe. None of them reach the masthead.
    expect(Object.keys(meta)).toEqual(["source", "tags"]);
  });

  it("keeps a non-URL source visible but unlinked", () => {
    expect(buildRecipeMeta({ source: "ad-hoc" })).toEqual({ source: { label: "ad-hoc", href: null }, tags: [] });
  });

  it("drops a hostless scheme rather than linking or half-rendering it", () => {
    expect(buildRecipeMeta({ source: "javascript:alert(1)" }).source).toBeNull();
    expect(buildRecipeMeta({ source: "ftp://files.example.com/r" }).source).toEqual({
      label: "files.example.com",
      href: null
    });
  });

  it("reads tags from a bracketed list, a comma list, and a single value", () => {
    expect(buildRecipeMeta({ tags: '[one, "two"]' }).tags).toEqual(["one", "two"]);
    expect(buildRecipeMeta({ tags: "alpha, beta" }).tags).toEqual(["alpha", "beta"]);
    expect(buildRecipeMeta({ tags: "solo" }).tags).toEqual(["solo"]);
  });

  it("reports nothing for a recipe with no source and no tags", () => {
    expect(buildRecipeMeta({})).toEqual({ source: null, tags: [] });
  });
});
