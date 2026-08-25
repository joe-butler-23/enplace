import { describe, expect, it } from "vitest";
import { isDatabaseImagePriming, shouldIssueDetailPrewarm } from "./database-image-priming";

describe("isDatabaseImagePriming", () => {
  it("gates prewarming while background database data is unpublished", () => {
    const items = [];
    expect(isDatabaseImagePriming(true, true, items, false)).toBe(true);
  });

  it("gates prewarming while some covers in the current view have not settled yet", () => {
    const items = [{}, {}];
    expect(isDatabaseImagePriming(true, false, items, false)).toBe(true);
  });

  it("resumes prewarming once every cover in the current view has settled", () => {
    const items = [{}];
    expect(isDatabaseImagePriming(true, false, items, true)).toBe(false);
  });

  it("does not gate before database warming is requested", () => {
    const items = [{}];
    expect(isDatabaseImagePriming(false, true, items, false)).toBe(false);
  });

  it("does not hold prewarming after an empty database query completes", () => {
    expect(isDatabaseImagePriming(true, false, [], false)).toBe(false);
  });

  it("does not issue detail prewarming while Database is active", () => {
    expect(shouldIssueDetailPrewarm("database", false)).toBe(false);
    expect(shouldIssueDetailPrewarm("planner", true)).toBe(false);
    expect(shouldIssueDetailPrewarm("planner", false)).toBe(true);
  });

});
