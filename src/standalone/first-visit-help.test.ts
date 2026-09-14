import { describe, expect, it } from "vitest";
import { shouldShowFirstVisitHelp } from "./first-visit-help";

describe("first-visit Help", () => {
  it("opens once per device and never with the save-link notice", () => {
    expect(shouldShowFirstVisitHelp(false, false)).toBe(true);
    expect(shouldShowFirstVisitHelp(true, false)).toBe(false);
    expect(shouldShowFirstVisitHelp(false, true)).toBe(false);
  });
});
