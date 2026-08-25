import { describe, expect, it } from "vitest";
import {
  composeMarkdown,
  extractRecipeTitle,
  formatPropertyLabel,
  formatPropertyValue,
  getPropertyHref,
  normalizeFrontmatterValue,
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
    expect(formatPropertyValue("tags", parsed.frontmatter.tags)).toBe("one • two");
  });

  it("normalizes frontmatter values", () => {
    expect(normalizeFrontmatterValue("true")).toBe(true);
    expect(normalizeFrontmatterValue("42")).toBe(42);
    expect(normalizeFrontmatterValue("[one, \"two\"]")).toEqual(["one", "two"]);
    expect(normalizeFrontmatterValue("alpha, beta")).toEqual(["alpha", "beta"]);
  });

  it("formats labels and values consistently", () => {
    expect(formatPropertyLabel("prep_time")).toBe("Prep Time");
    expect(formatPropertyValue("source", "https://www.example.com/recipe")).toBe("example.com");
    expect(getPropertyHref("source", "https://www.example.com/recipe")).toBe(
      "https://www.example.com/recipe"
    );
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

  it("composes markdown and strips leading h1", () => {
    expect(composeMarkdown(null, "Body")).toBe("Body");
    const combined = composeMarkdown("title: Pasta", "Body");
    expect(combined.startsWith("---")).toBe(true);

    const stripped = stripLeadingH1("# Title\n\nBody");
    expect(stripped).toBe("\nBody");

    expect(extractRecipeTitle("Body", "Fallback")).toBe("Fallback");
  });
});
