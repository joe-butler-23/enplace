import { describe, it, expect, vi } from "vitest";
import { normalizeFieldValue, readFieldValue, getItemColumn } from "../utils/field-manager";

// Mock moment to track if it's called with invalid values
vi.mock("obsidian", () => {
  const mockMoment = (value: unknown) => {
    // Track what value was passed
    if (value === null || value === undefined) {
      throw new Error(`moment called with invalid value: ${value}`);
    }
    return {
      isValid: () => typeof value === "string" && value.trim() !== "",
      format: (fmt: string) => `formatted-${fmt}`
    };
  };
  return {
    moment: mockMoment,
    App: class {},
    TFile: class {}
  };
});

describe("normalizeFieldValue", () => {
  it("returns undefined for null value", () => {
    const result = normalizeFieldValue(null, "date");
    expect(result).toBeUndefined();
  });

  it("returns undefined for undefined value", () => {
    const result = normalizeFieldValue(undefined, "date");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string date", () => {
    const result = normalizeFieldValue("", "date");
    expect(result).toBeUndefined();
  });

  it("returns undefined for whitespace-only date", () => {
    const result = normalizeFieldValue("   ", "date");
    expect(result).toBeUndefined();
  });

  it("returns undefined for string null date", () => {
    const result = normalizeFieldValue("null", "date");
    expect(result).toBeUndefined();
  });

  it("returns trimmed value for valid date string", () => {
    const result = normalizeFieldValue("2026-02-08", "date");
    expect(result).toBe("2026-02-08");
  });

  it("handles boolean type correctly", () => {
    expect(normalizeFieldValue(true, "boolean")).toBe(true);
    expect(normalizeFieldValue(false, "boolean")).toBe(false);
    expect(normalizeFieldValue("true", "boolean")).toBe(true);
    expect(normalizeFieldValue("false", "boolean")).toBe(false);
  });

  it("handles string type correctly", () => {
    expect(normalizeFieldValue("hello", "string")).toBe("hello");
    expect(normalizeFieldValue("  trimmed  ", "string")).toBe("trimmed");
  });
});

describe("readFieldValue", () => {
  it("returns undefined when frontmatter field is null", () => {
    const frontmatter = { scheduled: null };
    const mapping = { field: "scheduled", type: "date" as const };
    const result = readFieldValue(frontmatter, mapping);
    expect(result).toBeUndefined();
  });

  it("returns undefined when frontmatter field is undefined", () => {
    const frontmatter = {};
    const mapping = { field: "scheduled", type: "date" as const };
    const result = readFieldValue(frontmatter, mapping);
    expect(result).toBeUndefined();
  });

  it("uses fallback field when primary is null", () => {
    const frontmatter = { scheduled: null, date: "2026-02-08" };
    const mapping = { field: "scheduled", fallbackField: "date", type: "date" as const };
    const result = readFieldValue(frontmatter, mapping);
    expect(result).toBe("2026-02-08");
  });
});
