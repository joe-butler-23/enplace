import { App, TFile } from "@/platform";

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
  app: App,
  file: TFile,
  entry: CookLogEntryInput
): Promise<void> {
  const content = await app.vault.read(file);
  const entryText = formatCookLogEntry(entry);
  const updated = appendCookLogEntryToContent(content, entryText);
  if (updated !== content) {
    await app.vault.modify(file, updated);
  }
}
