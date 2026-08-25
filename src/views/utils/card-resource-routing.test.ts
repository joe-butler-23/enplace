import { describe, expect, it } from "vitest";
import { isDirectCardSource } from "./card-resource-routing";

describe("isDirectCardSource", () => {
  it("keeps custom and remote cover sources out of the immutable thumbnail blob lane", () => {
    for (const source of ["https://example.test/cover.jpg", "data:image/png;base64,aa", "blob:test", "file:///tmp/cover.jpg", "asset://cover", "app://cover", "obsidian://cover"]) {
      expect(isDirectCardSource(source)).toBe(true);
    }
    expect(isDirectCardSource("/vault/recipes/cover.jpg")).toBe(false);
  });
});
