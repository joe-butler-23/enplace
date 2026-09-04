const LOG_HEADING = "## Cook Log";

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export type CookLogEntry = {
  date: string;
  rating: number | null;
  makeAgain: boolean | null;
  notes: string;
};

/**
 * Renders an ISO date the way the log displays it, in UTC so the calendar day is
 * stable in negative-offset timezones. A date the writer did not produce is shown
 * verbatim rather than guessed at.
 */
export function formatCookLogDate(value: string): string {
  const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!iso) return value.trim();
  const [, year, month, day] = iso;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function parseCookLogHeader(line: string): CookLogEntry | null {
  const header = line.match(/^-\s+(.*)$/);
  if (!header) return null;
  const [date, ...fields] = header[1].split("|").map((part) => part.trim());
  const rating = fields.map((field) => field.match(/^rating:\s*(-?\d+(?:\.\d+)?)$/i)).find(Boolean);
  const again = fields.map((field) => field.match(/^make again:\s*(yes|no)$/i)).find(Boolean);
  return { date,
    rating: rating ? Number(rating[1]) : null,
    makeAgain: again ? again[1].toLowerCase() === "yes" : null,
    notes: "" };
}

function parseCookLogNote(line: string): string | null {
  const noteStart = line.match(/^\s+-\s+Notes:\s*(.*)$/i);
  const noteMore = line.match(/^\s{4,}(\S.*)$/);
  return noteStart ? noteStart[1] : noteMore ? noteMore[1] : null;
}

/** Reads a `## Cook Log` section, newest first as its entries are written. */
export function parseCookLog(markdown: string): CookLogEntry[] {
  const lines = normalizeNewlines(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === LOG_HEADING.toLowerCase());
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line.trim()));
  const entries: CookLogEntry[] = [];

  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    const entry = parseCookLogHeader(line);
    if (entry) {
      entries.push(entry);
      continue;
    }
    const current = entries[entries.length - 1];
    const note = parseCookLogNote(line);
    if (current && note !== null) current.notes = [current.notes, note].filter(Boolean).join(" ").trim();
  }

  return entries.filter((entry) => entry.date.length > 0);
}
