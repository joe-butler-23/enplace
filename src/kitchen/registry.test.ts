import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentKitchenId,
  currentKitchenId,
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


});
