import { updateText } from "@/host-client/browser-storage";

export type CookLogEntryInput = {
  cookedDate: string;
  rating?: number | null;
  makeAgain?: boolean | null;
  notes?: string | null;
};

const LOG_HEADING = "## Cook Log";

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function formatCookLogEntry(entry: CookLogEntryInput): string {
  const cookedDate = entry.cookedDate.trim();
  const parts = [cookedDate];

  if (entry.rating !== null && entry.rating !== undefined) {
    parts.push(`rating: ${entry.rating}`);
  }
  if (entry.makeAgain !== null && entry.makeAgain !== undefined) {
    parts.push(`make again: ${entry.makeAgain ? "yes" : "no"}`);
  }

  const lines = [`- ${parts.join(" | ")}`];
  const notes = entry.notes?.trim();
  if (notes) {
    const noteLines = normalizeNewlines(notes).split("\n");
    lines.push(`  - Notes: ${noteLines[0]}`);
    for (const line of noteLines.slice(1)) {
      lines.push(`    ${line}`);
    }
  }

  return lines.join("\n");
}

export function appendCookLogEntryToContent(
  content: string,
  entryText: string
): string {
  const normalized = normalizeNewlines(content);
  const lines = normalized.split("\n");
  const headingIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === LOG_HEADING.toLowerCase()
  );

  if (headingIndex === -1) {
    const trimmed = normalized.replace(/\s+$/, "");
    const separator = trimmed ? "\n\n" : "";
    return `${trimmed}${separator}${LOG_HEADING}\n${entryText}\n`;
  }

  let insertIndex = headingIndex + 1;
  if (lines[insertIndex] === undefined) {
    lines.push("");
    insertIndex = lines.length;
  } else if (lines[insertIndex].trim() !== "") {
    lines.splice(insertIndex, 0, "");
    insertIndex += 1;
  } else {
    insertIndex += 1;
  }

  const entryLines = entryText.split("\n");
  lines.splice(insertIndex, 0, ...entryLines, "");
  return lines.join("\n");
}

export async function appendCookLogEntryToFile(
  path: string,
  entry: CookLogEntryInput
): Promise<void> {
  const entryText = formatCookLogEntry(entry);
  await updateText(path, (current) => appendCookLogEntryToContent(current, entryText));
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

/** Reads back what formatCookLogEntry writes, newest first as the writer inserts them. */
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
