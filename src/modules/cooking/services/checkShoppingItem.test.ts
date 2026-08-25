import { describe, expect, it, vi } from "vitest";
import type { ShoppingList } from "@/host-client/commands";
import { checkShoppingItem } from "./checkShoppingItem";

const list: ShoppingList = {
  schemaVersion: 1,
  revision: 4,
  weekLabel: "This week",
  items: [
    { id: "milk", content: "milk", labels: ["dairy"], sources: ["Pancakes"], checked: false }
  ],
  rollback: null
};

describe("checkShoppingItem", () => {
  it("publishes the checked state before persistence resolves", async () => {
    let resolvePersist!: (value: ShoppingList) => void;
    const persist = vi.fn(
      () => new Promise<ShoppingList>((resolve) => { resolvePersist = resolve; })
    );
    const published: ShoppingList[] = [];

    const pending = checkShoppingItem({
      list,
      itemId: "milk",
      checked: true,
      publish: (value) => published.push(value),
      persist
    });

    expect(published).toHaveLength(1);
    expect(published[0].items[0].checked).toBe(true);
    expect(published[0].revision).toBe(4);
    expect(persist).toHaveBeenCalledWith({
      expectedRevision: 4,
      itemId: "milk",
      checked: true
    });

    const authoritative = {
      ...list,
      revision: 5,
      items: [{ ...list.items[0], checked: true }]
    };
    resolvePersist(authoritative);
    await pending;

    expect(published).toEqual([expect.objectContaining({ revision: 4 }), authoritative]);
  });

  it("restores the authoritative state when persistence fails", async () => {
    const published: ShoppingList[] = [];

    await expect(checkShoppingItem({
      list,
      itemId: "milk",
      checked: true,
      publish: (value) => published.push(value),
      persist: () => Promise.reject(new Error("write failed"))
    })).rejects.toThrow("write failed");

    expect(published.map((value) => value.items[0].checked)).toEqual([true, false]);
  });
});
