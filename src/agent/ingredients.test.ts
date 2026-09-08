import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenIngredients, parseRecipeMD } from "../recipemd";
import { editIngredients, ingredientSpans } from "./ingredients";

const directory = new URL("../../tests/fixtures/recipemd/", import.meta.url);
const fixtures = readdirSync(directory).filter(name => name.endsWith(".md") && !name.endsWith(".invalid.md"));

describe("ingredient source ranges", () => {
  it.each(fixtures)("retains every source byte for unchanged items in %s", name => {
    const original = readFileSync(new URL(name, directory), "utf8");
    for (const markdown of [original, original.replace(/\r?\n/g, "\r\n")]) {
      const parsed = ingredientSpans(markdown);
      expect(parsed.items.map(item => item.content)).toEqual(flattenIngredients(parseRecipeMD(markdown)).map(item => item.raw));
      const edits = parsed.items.map(item => ({ ingredientId: item.id, content: item.content }));
      expect(editIngredients(markdown, edits)).toBe(markdown);
      for (const item of parsed.items) {
        expect(markdown.slice(item.start, item.end).replace(/\r\n/g, "\n")).toBe(item.content);
      }
    }
  });
});
