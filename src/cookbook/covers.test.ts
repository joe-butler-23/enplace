import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openCookbook } from "../host-client/cookbook-storage";
import { readCookbookBytes, writeCookbookBytes, writeCookbookText } from "./doc";
import { backfillCookbookCovers, cardCoverUrl, COVER_BACKFILL_ORIGIN, coverGeometry, thumbnailPathForCover } from "./covers";

describe("cover files", () => {
  it("names automatic writes for the cookbook", () => {
    expect(COVER_BACKFILL_ORIGIN.description).toBe("enplace-cookbook-cover-backfill");
  });

  it("derives one deterministic WebP sibling path", () => {
    expect(thumbnailPathForCover("images/dish.jpg")).toBe("images/dish.card.webp");
    expect(thumbnailPathForCover("images/dish.webp")).toBe("images/dish.card.webp");
    expect(thumbnailPathForCover("dish")).toBe("dish.card.webp");
  });

  it("uses the card thumbnail with the legacy cover as the only fallback", () => {
    expect(cardCoverUrl("images/dish.jpg", new Map([
      ["images/dish.jpg", "blob:cover"], ["images/dish.card.webp", "blob:thumbnail"],
    ]))).toBe("blob:thumbnail");
    expect(cardCoverUrl("images/dish.jpg", new Map([["images/dish.jpg", "blob:cover"]])))
      .toBe("blob:cover");
  });

  it("caps the longest side and centre-crops the thumbnail", () => {
    expect(coverGeometry(2000, 1000)).toEqual({
      cappedWidth: 1280, cappedHeight: 640, cropX: 500, cropY: 0, cropSize: 1000,
    });
    expect(coverGeometry(800, 1600)).toEqual({
      cappedWidth: 640, cappedHeight: 1280, cropX: 0, cropY: 400, cropSize: 800,
    });
  });

  it("backfills one shared legacy cover without counting it as a first local write", async () => {
    const firstLocalWrite = vi.fn();
    const connection = await openCookbook({
      id: `test-${crypto.randomUUID()}`,
      relayUrl: null,
      persist: false,
      onFirstLocalWrite: firstLocalWrite,
      seed(doc) {
        writeCookbookText(doc, "a.md", "---\ncover: images/legacy.jpg\n---\n## Ingredients\n- a\n");
        writeCookbookText(doc, "b.md", "---\ncover: images/legacy.jpg\n---\n## Ingredients\n- b\n");
        writeCookbookBytes(doc, "images/legacy.jpg", new Uint8Array([1, 2, 3]));
      },
    });
    const normalizedCover = new Uint8Array([4, 5]);
    const transform = vi.fn(async () => ({
      cover: normalizedCover, thumbnail: new Uint8Array([6]),
    }));
    try {
      await expect(backfillCookbookCovers(connection.doc, transform)).resolves.toBe(1);
      expect(transform).toHaveBeenCalledOnce();
      expect(readCookbookBytes(connection.doc, "images/legacy.jpg")).toEqual(normalizedCover);
      expect(readCookbookBytes(connection.doc, "images/legacy.card.webp")).toEqual(new Uint8Array([6]));
      expect(firstLocalWrite).not.toHaveBeenCalled();
      await connection.adapter.writeBytes("Plan.md", new TextEncoder().encode("## Marked\n"));
      expect(firstLocalWrite).toHaveBeenCalledOnce();
      await expect(backfillCookbookCovers(connection.doc, transform)).resolves.toBe(0);
      expect(transform).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });

  it("leaves remote covers and invalid local covers usable through the resolver fallback", async () => {
    const doc = new Y.Doc();
    writeCookbookText(doc, "remote.md", "---\ncover: https://example.test/dish.jpg\n---\n## Ingredients\n- a\n");
    writeCookbookText(doc, "local.md", "---\ncover: images/broken.jpg\n---\n## Ingredients\n- b\n");
    writeCookbookBytes(doc, "images/broken.jpg", new Uint8Array([1]));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(backfillCookbookCovers(doc, async () => { throw new Error("bad image"); })).resolves.toBe(0);
    expect(warning).toHaveBeenCalledOnce();
    expect(readCookbookBytes(doc, "images/broken.jpg")).toEqual(new Uint8Array([1]));
  });
});
