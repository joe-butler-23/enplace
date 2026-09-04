import { describe, expect, it } from "vitest";
import { formatCookLogDate, parseCookLog } from "./RecipeLogService";

describe("cook log reading", () => {
  it("reads a full entry with a wrapped note", () => {
    const content = [
      "# Soup",
      "",
      "## Cook Log",
      "",
      "- 2026-08-14 | rating: 4 | make again: yes",
      "  - Notes: Halved the onion.",
      "    Still needs more vinegar."
    ].join("\n");

    expect(parseCookLog(content)).toEqual([
      {
        date: "2026-08-14",
        rating: 4,
        makeAgain: true,
        notes: "Halved the onion. Still needs more vinegar."
      }
    ]);
  });

  it("keeps newest-first order across several cooks", () => {
    const content = ["## Cook Log", "", "- 2026-08-14", "", "- 2026-08-03", ""].join("\n");
    expect(parseCookLog(content).map((entry) => entry.date)).toEqual(["2026-08-14", "2026-08-03"]);
  });

  it("carries a rating or a make-again verdict on its own", () => {
    const content = [
      "## Cook Log",
      "",
      "- 2026-08-14 | rating: 5",
      "- 2026-08-03 | make again: no"
    ].join("\n");

    expect(parseCookLog(content)).toEqual([
      { date: "2026-08-14", rating: 5, makeAgain: null, notes: "" },
      { date: "2026-08-03", rating: null, makeAgain: false, notes: "" }
    ]);
  });

  it("accepts writer fields in either order and ignores unknown fields", () => {
    const content = [
      "## Cook Log",
      "    stray text before the first entry",
      "- 2026-08-14 | make again: YES | source: notebook | rating: -1.5",
      "  - Notes: Needs another try."
    ].join("\n");

    expect(parseCookLog(content)).toEqual([
      { date: "2026-08-14", rating: -1.5, makeAgain: true, notes: "Needs another try." }
    ]);
  });

  it("stops at the next section and ignores an absent log", () => {
    const content = ["## Cook Log", "", "- 2026-08-14", "", "## Notes", "- not a cook"].join("\n");
    expect(parseCookLog(content).map((entry) => entry.date)).toEqual(["2026-08-14"]);
    expect(parseCookLog("# Soup\n\n## Notes\n\nNo log here.")).toEqual([]);
  });

  it("renders an ISO date on the same calendar day regardless of the local timezone", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(formatCookLogDate("2026-08-14")).toBe("14 Aug 2026");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("shows a date the writer did not produce verbatim rather than guessing", () => {
    expect(formatCookLogDate("sometime last spring")).toBe("sometime last spring");
  });
});
