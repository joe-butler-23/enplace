import { describe, expect, it } from "vitest";
import { acknowledgeCookbookLink, shouldShowFirstUseNotice } from "./first-use-notice";

describe("first-use link notice", () => {
  it("waits for a user-authored change, then stays dismissed only on this device", () => {
    expect(shouldShowFirstUseNotice("cookbook-a", [], true)).toBe(false);
    expect(shouldShowFirstUseNotice("cookbook-a", [], false)).toBe(true);
    const acknowledged = acknowledgeCookbookLink([], "cookbook-a");
    expect(shouldShowFirstUseNotice("cookbook-a", acknowledged, false)).toBe(false);
    expect(shouldShowFirstUseNotice("cookbook-b", acknowledged, false)).toBe(true);
  });

  it("does not add the same acknowledgement twice", () => {
    expect(acknowledgeCookbookLink(["cookbook-a"], "cookbook-a")).toEqual(["cookbook-a"]);
  });
});
