import { describe, expect, it } from "vitest";
import { mergeText } from "./merge";

const base = "# Soup\n\nFry the onions.\n\nAdd the stock.\n";

describe("mergeText", () => {
  it("composes edits to different paragraphs", () => {
    expect(mergeText(base, base.replace("Fry", "Soften"), base.replace("Add", "Pour in"))).toEqual({
      text: "# Soup\n\nSoften the onions.\n\nPour in the stock.\n",
      conflicts: 0,
    });
  });

  it("keeps both versions when the same paragraph changes", () => {
    expect(mergeText(base, base.replace("Fry the onions.", "Caramelise the onions."), base.replace("Fry the onions.", "Soften the onions."))).toEqual({
      text: "# Soup\n\n<<<<<<< this device\nCaramelise the onions.\n=======\nSoften the onions.\n>>>>>>>>\n\nAdd the stock.\n",
      conflicts: 1,
    });
  });

  it("keeps an edit and a deletion as a conflict", () => {
    const ours = base.replace("Fry the onions.\n\n", "Chop and fry the onions.\n\n");
    const theirs = base.replace("Fry the onions.\n\n", "");
    expect(mergeText(base, ours, theirs)).toEqual({
      text: "# Soup\n\n<<<<<<< this device\nChop and fry the onions.\n\n=======\n>>>>>>>>\nAdd the stock.\n",
      conflicts: 1,
    });
  });

  it("applies the same deletion once", () => {
    const deleted = base.replace("Fry the onions.\n\n", "");
    expect(mergeText(base, deleted, deleted)).toEqual({ text: deleted, conflicts: 0 });
  });

  it("de-duplicates the same appended line", () => {
    const appended = `${base}Serve hot.\n`;
    expect(mergeText(base, appended, appended)).toEqual({ text: appended, conflicts: 0 });
  });

  it("composes different same-position insertions ours-first", () => {
    expect(mergeText(base, `${base}Serve hot.\n`, `${base}Add parsley.\n`)).toEqual({
      text: `${base}Serve hot.\nAdd parsley.\n`,
      conflicts: 0,
    });
  });

  it("de-duplicates two devices creating the same file from an empty base", () => {
    const created = "# New recipe\nNo duplicates.\n";
    expect(mergeText("", created, created)).toEqual({ text: created, conflicts: 0 });
  });

  it("is idempotent when the merged text becomes the next base", () => {
    const merged = mergeText(base, base.replace("Fry", "Soften"), base.replace("Add", "Pour in"));
    expect(mergeText(merged.text, merged.text, merged.text)).toEqual({ text: merged.text, conflicts: 0 });
  });

  it("separates same-position EOF insertions that have no trailing newlines", () => {
    expect(mergeText("", "Alice", "Bob")).toEqual({ text: "Alice\nBob", conflicts: 0 });
  });

  it("keeps a no-newline overlap stable at EOF", () => {
    const result = mergeText("base", "ours", "theirs");
    expect(result).toEqual({
      text: "<<<<<<< this device\nours\n=======\ntheirs\n>>>>>>>>",
      conflicts: 1,
    });
    expect(mergeText("base", "ours", "theirs")).toEqual(result);
  });

  it("preserves whether an unconflicted file has a trailing newline", () => {
    expect(mergeText("a\nb", "A\nb", "a\nB")).toEqual({ text: "A\nB", conflicts: 0 });
  });
});
