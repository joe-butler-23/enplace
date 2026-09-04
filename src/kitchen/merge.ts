export type MergeResult = { text: string; conflicts: number };

type TextHunk = { start: number; end: number; lines: string[]; side: "ours" | "theirs" };

const CONFLICT_START = "<<<<<<< this device\n";
const CONFLICT_MIDDLE = "=======\n";
const CONFLICT_END = ">>>>>>>>";

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function commonLineLengths(leftLines: string[], rightLines: string[]): Uint32Array[] {
  const lengths = Array.from({ length: leftLines.length + 1 }, () => new Uint32Array(rightLines.length + 1));
  for (let left = leftLines.length - 1; left >= 0; left -= 1) {
    for (let right = rightLines.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = leftLines[left] === rightLines[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  return lengths;
}

function diffHunks(base: string[], next: string[], side: TextHunk["side"]): TextHunk[] {
  const lengths = commonLineLengths(base, next);
  const hunks: TextHunk[] = [];
  let left = 0;
  let right = 0;
  let hunk: TextHunk | null = null;
  while (left < base.length || right < next.length) {
    if (left < base.length && right < next.length && base[left] === next[right]) {
      if (hunk) hunks.push(hunk);
      hunk = null;
      left += 1;
      right += 1;
      continue;
    }
    hunk ??= { start: left, end: left, lines: [], side };
    if (right < next.length && (left === base.length || lengths[left][right + 1] >= lengths[left + 1][right])) {
      hunk.lines.push(next[right]);
      right += 1;
    } else {
      hunk.end += 1;
      left += 1;
    }
  }
  if (hunk) hunks.push(hunk);
  return hunks;
}

function related(left: TextHunk, right: TextHunk): boolean {
  if (left.side === right.side) return false;
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start > right.start && left.start < right.end;
  if (rightInsertion) return right.start > left.start && right.start < left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function applyHunks(base: string[], start: number, end: number, hunks: TextHunk[]): string[] {
  const output: string[] = [];
  let cursor = start;
  for (const hunk of [...hunks].sort((left, right) => left.start - right.start || left.end - right.end)) {
    output.push(...base.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  output.push(...base.slice(cursor, end));
  return output;
}

function conflictLines(ours: string[], theirs: string[], trailingNewline: boolean): string[] {
  return [CONFLICT_START, ...ours, CONFLICT_MIDDLE, ...theirs, trailingNewline ? `${CONFLICT_END}\n` : CONFLICT_END];
}

/** Shortest common supersequence, with our line first when either order is valid. */
function mergeInsertions(ours: string[], theirs: string[]): string[] {
  const lengths = commonLineLengths(ours, theirs);
  const output: string[] = [];
  let left = 0;
  let right = 0;
  while (left < ours.length || right < theirs.length) {
    if (left < ours.length && right < theirs.length && ours[left] === theirs[right]) {
      output.push(ours[left]);
      left += 1;
      right += 1;
    } else if (left < ours.length && (right === theirs.length || lengths[left + 1][right] >= lengths[left][right + 1])) {
      output.push(ours[left++]);
    } else {
      output.push(theirs[right++]);
    }
  }
  return output;
}

function joinLines(lines: string[]): string {
  return lines.map((line, index) => index < lines.length - 1 && !line.endsWith("\n") ? `${line}\n` : line).join("");
}

function relatedHunkGroups(hunks: TextHunk[]): TextHunk[][] {
  const visited = new Set<number>();
  const groups: TextHunk[][] = [];
  for (let root = 0; root < hunks.length; root += 1) {
    if (visited.has(root)) continue;
    visited.add(root);
    const pending = [root];
    const group: TextHunk[] = [];
    while (pending.length) {
      const index = pending.pop()!;
      group.push(hunks[index]);
      for (let candidate = 0; candidate < hunks.length; candidate += 1) {
        if (visited.has(candidate) || !related(hunks[index], hunks[candidate])) continue;
        visited.add(candidate);
        pending.push(candidate);
      }
    }
    groups.push(group);
  }
  groups.sort((left, right) => {
    const leftStart = Math.min(...left.map((hunk) => hunk.start));
    const rightStart = Math.min(...right.map((hunk) => hunk.start));
    const leftInsertion = left.every((hunk) => hunk.start === hunk.end);
    const rightInsertion = right.every((hunk) => hunk.start === hunk.end);
    return leftStart - rightStart || Number(!leftInsertion) - Number(!rightInsertion);
  });
  return groups;
}

/** Line-based three-way merge. Overlapping edits are preserved as readable conflict blocks. */
export function mergeText(baseText: string, oursText: string, theirsText: string): MergeResult {
  if (oursText === theirsText) return { text: oursText, conflicts: 0 };
  if (oursText === baseText) return { text: theirsText, conflicts: 0 };
  if (theirsText === baseText) return { text: oursText, conflicts: 0 };

  const base = splitLines(baseText);
  const hunks = [
    ...diffHunks(base, splitLines(oursText), "ours"),
    ...diffHunks(base, splitLines(theirsText), "theirs"),
  ];
  const groups = relatedHunkGroups(hunks);
  const output: string[] = [];
  let cursor = 0;
  let conflicts = 0;
  for (const group of groups) {
    const start = Math.min(...group.map((hunk) => hunk.start));
    const end = Math.max(...group.map((hunk) => hunk.end));
    output.push(...base.slice(cursor, start));
    const oursHunks = group.filter((hunk) => hunk.side === "ours");
    const theirsHunks = group.filter((hunk) => hunk.side === "theirs");
    if (!oursHunks.length || !theirsHunks.length) {
      output.push(...applyHunks(base, start, end, group));
    } else {
      const ours = applyHunks(base, start, end, oursHunks);
      const theirs = applyHunks(base, start, end, theirsHunks);
      if (ours.join("") === theirs.join("")) output.push(...ours);
      else if (group.every((hunk) => hunk.start === hunk.end)) output.push(...mergeInsertions(ours, theirs));
      else {
        output.push(...conflictLines(ours, theirs, oursText.endsWith("\n") || theirsText.endsWith("\n")));
        conflicts += 1;
      }
    }
    cursor = Math.max(cursor, end);
  }
  output.push(...base.slice(cursor));
  return { text: joinLines(output), conflicts };
}
