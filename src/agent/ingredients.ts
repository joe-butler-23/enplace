import { Lexer, type Tokens } from "marked";
import { parseRecipeMD, parseRecipeIngredient } from "../recipemd";

type IngredientSpan = { id: string; content: string; groups: string[]; start: number; end: number };

/** CommonMark owns ingredient boundaries. Offsets only locate those tokens in the original bytes. */
export function ingredientSpans(markdown: string): { title: string; yields: ReturnType<typeof parseRecipeMD>["yields"]; items: IngredientSpan[] } {
  const offsets: number[] = [];
  let normalized = "";
  for (let i = 0; i < markdown.length; i++) {
    offsets.push(i);
    if (markdown[i] === "\r") {
      normalized += "\n";
      if (markdown[i + 1] === "\n") i++;
    } else normalized += markdown[i];
  }
  offsets.push(markdown.length);
  const recipe = parseRecipeMD(normalized);
  const locate = (raw: string, from: number, limit: number): { start: number; end: number } => {
    const start = normalized.indexOf(raw, from);
    if (start >= from && start + raw.length <= limit) return { start, end: start + raw.length };
    // Marked can replace the final list's trailing spaces with a synthetic newline.
    const trimmed = raw.trimEnd(), last = normalized.indexOf(trimmed, from);
    if (trimmed && last >= from && normalized.slice(last, limit).trimEnd() === trimmed) return { start: last, end: limit };
    throw new Error("Cannot locate ingredient source bytes.");
  };
  const items: IngredientSpan[] = [];
  const groups: { depth: number; title: string }[] = [];
  let cursor = 0, active = false;
  for (const token of Lexer.lex(normalized, { gfm: false })) {
    const { start, end } = locate(token.raw, cursor, normalized.length);
    cursor = end;
    if (token.type === "hr") {
      if (active) break;
      active = true;
      continue;
    }
    if (!active) continue;
    if (token.type === "heading") {
      const heading = token as Tokens.Heading;
      while (groups.length && groups[groups.length - 1].depth >= heading.depth) groups.pop();
      groups.push({ depth: heading.depth, title: heading.text });
    }
    if (token.type !== "list") continue;
    let itemCursor = start;
    for (const item of (token as Tokens.List).items) {
      const location = locate(item.raw, itemCursor, cursor), itemStart = location.start;
      itemCursor = location.end;
      const prefix = /^\s*(?:[-+*]|\d+[.)])\s+/.exec(item.raw)?.[0];
      if (!prefix) throw new Error("Cannot locate ingredient marker.");
      const end = itemStart + item.raw.trimEnd().length;
      items.push({ id: `ingredient:${items.length}`, content: normalized.slice(itemStart + prefix.length, end),
        groups: groups.map(group => group.title), start: offsets[itemStart + prefix.length], end: offsets[end] });
    }
  }
  return { title: recipe.title, yields: recipe.yields, items };
}

export function editIngredients(markdown: string, edits: { ingredientId: string; content: string }[]): string {
  const before = ingredientSpans(markdown);
  const replacements = new Map<string, string>();
  for (const edit of edits) {
    if (replacements.has(edit.ingredientId)) throw new Error("Select each ingredient once.");
    if (!before.items.some(item => item.id === edit.ingredientId)) throw new Error("Ingredient selection no longer exists.");
    const content = edit.content.replace(/\r\n?/g, "\n").trimEnd();
    parseRecipeIngredient(content);
    replacements.set(edit.ingredientId, content);
  }
  let result = markdown;
  for (const item of [...before.items].reverse()) {
    const content = replacements.get(item.id);
    if (content === undefined) continue;
    const newline = markdown.includes("\r\n") ? "\r\n" : markdown.includes("\r") ? "\r" : "\n";
    result = result.slice(0, item.start) + content.replace(/\n/g, newline) + result.slice(item.end);
  }
  const after = ingredientSpans(result);
  // Reject list/heading/divider breakouts; a replacement must remain exactly its one item.
  if (after.items.length !== before.items.length || after.items.some((item, index) =>
    item.content !== (replacements.get(item.id) ?? before.items[index].content)
    || JSON.stringify(item.groups) !== JSON.stringify(before.items[index].groups))) {
    throw new Error("An ingredient edit must preserve ingredient and group boundaries.");
  }
  return result;
}
