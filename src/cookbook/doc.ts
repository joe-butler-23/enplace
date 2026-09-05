import * as Y from "yjs";
import { isEncryptedCookbookId } from "./crypto";

/**
 * The cookbook document schema.
 *
 * One Yjs document per cookbook. The `files` map lists every file the folder would hold, keyed
 * by folder-relative path. A text file (Markdown and friends) is marked `"text"` in the map and
 * its content lives in the top-level shared text named `text:<path>`; every other file stores
 * its bytes in the map directly. Directories are implied by the paths of the files inside them.
 * Deleting a text file removes only its map membership: the orphaned shared text remains so a
 * concurrent edit can restore the file without losing content. Those orphan bytes are the cost
 * of preserving delete-versus-edit correctness.
 *
 * Text content is a top-level type rather than a value nested under the map key on purpose:
 * two devices creating the same file at the same moment then edit one shared text instead of
 * racing to own the key, so neither device's content is discarded. Concurrent file/directory
 * collisions stay untouched in Yjs and receive filesystem-safe names through one derived projection.
 *
 * This module is shared by browser code and tests. It knows nothing
 * about persistence or transport.
 */

export const FILES_KEY = "files";
const TEXT_MARK = "text";
const TEXT_PREFIX = "text:";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "csv", "html", "css", "js", "ts"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type CookbookFiles = Y.Map<typeof TEXT_MARK | Uint8Array>;

export function cookbookFiles(doc: Y.Doc): CookbookFiles {
  return doc.getMap<typeof TEXT_MARK | Uint8Array>(FILES_KEY);
}

function cookbookText(doc: Y.Doc, path: string): Y.Text {
  return doc.getText(`${TEXT_PREFIX}${path}`);
}

export function normalizeCookbookPath(path: string): string {
  if (/^(?:[\\/]|[A-Za-z]:)/.test(path)) throw new Error(`Invalid folder path: ${path}`);
  const values = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (values.some((value) => value === "." || value === "..")) throw new Error(`Invalid folder path: ${path}`);
  return values.join("/");
}

/** Returns a file which makes `path` unrepresentable in a real folder. */
export function cookbookPathConflict(paths: Iterable<string>, path: string): string | null {
  for (const candidate of paths) {
    if (candidate === path || path.startsWith(`${candidate}/`) || candidate.startsWith(`${path}/`)) return candidate;
  }
  return null;
}


type CookbookPathProjection = {
  rawToVisible: Map<string, string>;
  visibleToRaw: Map<string, string>;
};

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathFingerprint(path: string): string {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(path)) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function conflictName(path: string, attempt: number): string {
  const slash = path.lastIndexOf("/");
  const directory = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const suffix = ` (file conflict ${pathFingerprint(path)}${attempt === 1 ? "" : `-${attempt}`})`;
  if (dot > 0) return `${directory}${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
  if (dot === 0) return `${directory}file${suffix}${name}`;
  return `${directory}${name}${suffix}`;
}

/** Pure visible-folder projection. Raw Yjs keys and their Y.Text identities never move. */
function cookbookPathProjection(doc: Y.Doc): CookbookPathProjection {
  const rawPaths = [...cookbookFiles(doc).keys()].sort(comparePaths);
  const allRaw = new Set(rawPaths);
  const moved = new Set<string>(rawPaths.filter((path) => path === "__proto__"));
  for (const path of rawPaths) {
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
      const ancestor = path.slice(0, slash);
      if (allRaw.has(ancestor)) moved.add(ancestor);
    }
  }
  const rawToVisible = new Map<string, string>();
  const visibleToRaw = new Map<string, string>();
  const occupied = new Set(rawPaths.filter((path) => !moved.has(path)));
  for (const path of occupied) {
    rawToVisible.set(path, path);
    visibleToRaw.set(path, path);
  }
  for (const raw of [...moved].sort(comparePaths)) {
    let attempt = 1;
    let visible = conflictName(raw, attempt);
    while (allRaw.has(visible) || cookbookPathConflict(occupied, visible)) {
      attempt += 1;
      visible = conflictName(raw, attempt);
    }
    occupied.add(visible);
    rawToVisible.set(raw, visible);
    visibleToRaw.set(visible, raw);
  }
  return { rawToVisible, visibleToRaw };
}

function writableRawCookbookPath(doc: Y.Doc, input: string): string {
  const path = normalizeCookbookPath(input);
  if (!path) throw new Error("Cannot write the folder root.");
  const projection = cookbookPathProjection(doc);
  const existingRaw = projection.visibleToRaw.get(path);
  if (existingRaw) return existingRaw;
  if (cookbookFiles(doc).has(path)) throw new Error(`Cannot store ${input}: its raw path is hidden by projection.`);
  const conflict = cookbookPathConflict(projection.visibleToRaw.keys(), path);
  if (conflict) throw new Error(`Cannot store ${input}: it conflicts with file ${conflict}.`);
  return path;
}

export function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function listCookbookPaths(doc: Y.Doc): string[] {
  return [...cookbookPathProjection(doc).visibleToRaw.keys()].sort((left, right) => left.localeCompare(right));
}

export function hasCookbookFile(doc: Y.Doc, path: string): boolean {
  return cookbookPathProjection(doc).visibleToRaw.has(normalizeCookbookPath(path));
}

export function hasCookbookDirectory(doc: Y.Doc, path: string): boolean {
  const normalized = normalizeCookbookPath(path);
  if (!normalized) return true;
  const prefix = `${normalized}/`;
  for (const key of cookbookPathProjection(doc).visibleToRaw.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

export function readCookbookText(doc: Y.Doc, path: string): string | null {
  const key = normalizeCookbookPath(path);
  const raw = cookbookPathProjection(doc).visibleToRaw.get(key);
  if (!raw) return null;
  const entry = cookbookFiles(doc).get(raw);
  if (entry === undefined) return null;
  return entry === TEXT_MARK ? cookbookText(doc, raw).toString() : decoder.decode(entry);
}

function rawCookbookBytes(doc: Y.Doc, raw: string): Uint8Array | null {
  const entry = cookbookFiles(doc).get(raw);
  if (entry === undefined) return null;
  return entry === TEXT_MARK ? encoder.encode(cookbookText(doc, raw).toString()) : entry.slice();
}

export function readCookbookBytes(doc: Y.Doc, path: string): Uint8Array | null {
  const key = normalizeCookbookPath(path);
  const raw = cookbookPathProjection(doc).visibleToRaw.get(key);
  return raw ? rawCookbookBytes(doc, raw) : null;
}

/** Reads a whole projected cookbook from one derived path snapshot. */
export function walkCookbookFiles(doc: Y.Doc): Array<{ path: string; bytes: Uint8Array }> {
  const projection = cookbookPathProjection(doc);
  return [...projection.visibleToRaw]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, raw]) => ({ path, bytes: rawCookbookBytes(doc, raw) ?? new Uint8Array() }));
}

type TextDiffHunk = { start: number; end: number; lines: string[] };

function splitTextLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function textMatchLengths(current: string[], next: string[]): Uint32Array[] {
  const lengths = Array.from({ length: current.length + 1 }, () => new Uint32Array(next.length + 1));
  for (let left = current.length - 1; left >= 0; left -= 1) {
    for (let right = next.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = current[left] === next[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  return lengths;
}

function textDiffHunks(current: string[], next: string[]): TextDiffHunk[] {
  const lengths = textMatchLengths(current, next);
  const hunks: TextDiffHunk[] = [];
  let left = 0;
  let right = 0;
  let hunk: TextDiffHunk | null = null;
  while (left < current.length || right < next.length) {
    if (left < current.length && right < next.length && current[left] === next[right]) {
      if (hunk) hunks.push(hunk);
      hunk = null;
      left += 1;
      right += 1;
      continue;
    }
    hunk ??= { start: left, end: left, lines: [] };
    if (right < next.length && (left === current.length || lengths[left][right + 1] >= lengths[left + 1][right])) {
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

/** Applies minimal per-line changed regions, preserving unrelated concurrent edits between them. */
export function applyTextDiff(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  const currentLines = splitTextLines(current);
  const offsets = [0];
  for (const line of currentLines) offsets.push(offsets[offsets.length - 1] + line.length);
  const edits = textDiffHunks(currentLines, splitTextLines(next)).map((hunk) => {
    const before = currentLines.slice(hunk.start, hunk.end).join("");
    const after = hunk.lines.join("");
    let prefix = 0;
    const maxPrefix = Math.min(before.length, after.length);
    while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    const maxSuffix = maxPrefix - prefix;
    while (
      suffix < maxSuffix
      && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
    ) suffix += 1;
    return {
      index: offsets[hunk.start] + prefix,
      removed: before.length - prefix - suffix,
      inserted: after.slice(prefix, after.length - suffix),
    };
  });

  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit.removed > 0) text.delete(edit.index, edit.removed);
    if (edit.inserted) text.insert(edit.index, edit.inserted);
  }
}

export function writeCookbookText(doc: Y.Doc, path: string, next: string, origin?: unknown): void {
  const key = writableRawCookbookPath(doc, path);
  const files = cookbookFiles(doc);
  doc.transact(() => {
    // Always publish membership. A fresh Y.Map set must race a concurrent delete even when this
    // peer still sees the old marker locally.
    files.set(key, TEXT_MARK);
    applyTextDiff(cookbookText(doc, key), next);
  }, origin);
}

export function writeCookbookBytes(doc: Y.Doc, path: string, bytes: Uint8Array, origin?: unknown): void {
  if (isTextPath(path)) {
    writeCookbookText(doc, path, decoder.decode(bytes), origin);
    return;
  }
  const key = writableRawCookbookPath(doc, path);
  doc.transact(() => { cookbookFiles(doc).set(key, bytes.slice()); }, origin);
}

function deleteEntry(doc: Y.Doc, key: string): void {
  cookbookFiles(doc).delete(key);
}

/** Removes a file, or every file under a directory when `recursive` is set. Returns the removed paths. */
export function deleteCookbookPath(doc: Y.Doc, path: string, recursive = false, origin?: unknown): string[] {
  const key = normalizeCookbookPath(path);
  if (!key) throw new Error("Cannot remove the folder root.");
  const projection = cookbookPathProjection(doc);
  const exactRaw = projection.visibleToRaw.get(key);
  const prefix = `${key}/`;
  const children = [...projection.visibleToRaw].filter(([visible]) => visible.startsWith(prefix));
  if (!exactRaw && !children.length) throw new Error(`File not found: ${path}`);
  if (!exactRaw && !recursive) throw new Error(`Directory is not empty: ${path}`);
  const removed = recursive
    ? [...(exactRaw ? [[key, exactRaw] as const] : []), ...children]
    : [[key, exactRaw!] as const];
  doc.transact(() => { for (const [, raw] of removed) deleteEntry(doc, raw); }, origin);
  return removed.map(([visible]) => visible);
}

/**
 * Calls `listener` after every transaction that touched cookbook files, with the affected
 * folder-relative paths and the transaction origin. Returns the unsubscribe function.
 */
export function observeCookbook(
  doc: Y.Doc,
  listener: (paths: Set<string>, origin: unknown) => void,
): () => void {
  const files = cookbookFiles(doc);
  let previous = cookbookPathProjection(doc);
  const handler = (transaction: Y.Transaction): void => {
    const changedRaw = new Set<string>();
    const changes: ReadonlyMap<unknown, ReadonlySet<string | null>> = transaction.changed;
    for (const key of changes.get(files) ?? []) {
      if (key) changedRaw.add(key);
    }
    for (const [name, type] of doc.share) {
      if (name.startsWith(TEXT_PREFIX) && transaction.changed.has(type)) {
        changedRaw.add(name.slice(TEXT_PREFIX.length));
      }
    }
    if (!changedRaw.size) return;
    const next = cookbookPathProjection(doc);
    const paths = new Set<string>();
    for (const raw of new Set([...previous.rawToVisible.keys(), ...next.rawToVisible.keys()])) {
      const before = previous.rawToVisible.get(raw);
      const after = next.rawToVisible.get(raw);
      if (!changedRaw.has(raw) && before === after) continue;
      if (before) paths.add(before);
      if (after) paths.add(after);
    }
    previous = next;
    if (paths.size) listener(paths, transaction.origin);
  };
  doc.on("afterTransaction", handler);
  return () => doc.off("afterTransaction", handler);
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 52;

/** 260 random bits in the fragment; the encrypted provider derives a separate public room id. */
export function newCookbookId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  return "e1_" + Array.from(bytes, (byte) => ID_ALPHABET[byte % 32]).join("");
}

export const isCookbookId = isEncryptedCookbookId;

/**
 * The cookbook id travels in the URL fragment, which browsers never send with the page request,
 * so it stays out of the static host's logs. Encrypted links never become relay room names.
 */
export function cookbookIdFromUrl(url: string | URL): string | null {
  const hash = new URL(url, "http://localhost").hash.replace(/^#/, "");
  const value = new URLSearchParams(hash).get("k") ?? "";
  return isCookbookId(value) ? value : null;
}

export function cookbookLink(origin: string, id: string, pathname = "/"): string {
  const url = new URL(pathname, origin);
  url.hash = `k=${id}`;
  return url.toString();
}

export function withCookbookHash(url: string, id: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.hash = `k=${id}`;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
