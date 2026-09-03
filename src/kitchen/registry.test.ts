import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentKitchenId,
  currentKitchenId,
  recentKitchens,
  rememberKitchen,
  setCurrentKitchenId,
} from "./registry";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const id = "abcdefghijklmnopqrstuvwxyz";

describe("kitchen registry", () => {
  beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the current kitchen and clears it", () => {
    expect(currentKitchenId()).toBeNull();
    setCurrentKitchenId(id);
    expect(currentKitchenId()).toBe(id);
    clearCurrentKitchenId();
    expect(currentKitchenId()).toBeNull();
  });
  it("keeps recent kitchens labelled and ordered by last-opened time", () => {
    const second = "zyxwvutsrqponmlkjihgfedcba";
    rememberKitchen(id, "Soup", 10);
    rememberKitchen(second, "", 20);

    expect(recentKitchens()).toEqual([
      { id: second, label: "Empty kitchen", lastOpened: 20 },
      { id, label: "Soup", lastOpened: 10 },
    ]);
  });

  it("bounds the recent kitchen list", () => {
    for (let index = 0; index < 9; index += 1) {
      rememberKitchen(`${String.fromCharCode(97 + index)}${"a".repeat(25)}`, `Kitchen ${index}`, index);
    }

    expect(recentKitchens()).toHaveLength(8);
    expect(recentKitchens()[0].label).toBe("Kitchen 8");
    expect(recentKitchens().some((kitchen) => kitchen.label === "Kitchen 0")).toBe(false);
  });

});
