import { describe, expect, it } from "vitest";
import {
  appendCookLogEntryToContent,
  formatCookLogDate,
  formatCookLogEntry,
  parseCookLog
} from "./RecipeLogService";

describe("cook log round trip", () => {
  it("reads back exactly what the writer wrote", () => {
    const written = appendCookLogEntryToContent(
      "# Soup\n\n## Cook Log\n",
      formatCookLogEntry({
        cookedDate: "2026-08-14",
        rating: 4,
        makeAgain: true,
        notes: "Halved the onion.\nStill needs more vinegar."
      })
    );

    expect(parseCookLog(written)).toEqual([
      {
        date: "2026-08-14",
        rating: 4,
        makeAgain: true,
        notes: "Halved the onion. Still needs more vinegar."
      }
    ]);
  });

  it("keeps the writer's newest-first order across several cooks", () => {
    let content = "# Soup\n\n## Cook Log\n";
    for (const date of ["2026-08-03", "2026-08-14"]) {
      content = appendCookLogEntryToContent(content, formatCookLogEntry({ cookedDate: date }));
    }
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
