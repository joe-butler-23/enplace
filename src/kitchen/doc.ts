import * as Y from "yjs";

/**
 * The kitchen document schema.
 *
 * One Yjs document per kitchen. The `files` map lists every file the folder would hold, keyed
 * by folder-relative path. A text file (Markdown and friends) is marked `"text"` in the map and
 * its content lives in the top-level shared text named `text:<path>`; every other file stores
 * its bytes in the map directly. Directories are implied by the paths of the files inside them.
 *
 * Text content is a top-level type rather than a value nested under the map key on purpose:
 * two devices creating the same file at the same moment then edit one shared text instead of
 * racing to own the key, so neither device's content is discarded.
 *
 * This module is shared by the browser adapter, the CLI mirror, and tests. It knows nothing
 * about persistence or transport.
 */

export const FILES_KEY = "files";
const TEXT_MARK = "text";
const TEXT_PREFIX = "text:";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "csv", "html", "css", "js", "ts"]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type KitchenFiles = Y.Map<typeof TEXT_MARK | Uint8Array>;

export function kitchenFiles(doc: Y.Doc): KitchenFiles {
  return doc.getMap<typeof TEXT_MARK | Uint8Array>(FILES_KEY);
}

function kitchenText(doc: Y.Doc, path: string): Y.Text {
  return doc.getText(`${TEXT_PREFIX}${path}`);
}

export function normalizeKitchenPath(path: string): string {
  let values = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  if (values[0] === "appdata") values = [".mep", ...values.slice(1)];
  if (values[0] === "home" && values[1] === "vault") values = values.slice(2);
  if (values.some((value) => value === "." || value === "..")) throw new Error(`Invalid folder path: ${path}`);
  return values.join("/");
}

export function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLocaleLowerCase());
}

export function listKitchenPaths(doc: Y.Doc): string[] {
  return [...kitchenFiles(doc).keys()].sort((left, right) => left.localeCompare(right));
}

export function hasKitchenFile(doc: Y.Doc, path: string): boolean {
  return kitchenFiles(doc).has(normalizeKitchenPath(path));
}

export function hasKitchenDirectory(doc: Y.Doc, path: string): boolean {
  const normalized = normalizeKitchenPath(path);
  if (!normalized) return true;
  const prefix = `${normalized}/`;
  for (const key of kitchenFiles(doc).keys()) if (key.startsWith(prefix)) return true;
  return false;
}

export function readKitchenText(doc: Y.Doc, path: string): string | null {
  const key = normalizeKitchenPath(path);
  const entry = kitchenFiles(doc).get(key);
  if (entry === undefined) return null;
  return entry === TEXT_MARK ? kitchenText(doc, key).toString() : decoder.decode(entry);
}

export function readKitchenBytes(doc: Y.Doc, path: string): Uint8Array | null {
  const key = normalizeKitchenPath(path);
  const entry = kitchenFiles(doc).get(key);
  if (entry === undefined) return null;
  return entry === TEXT_MARK ? encoder.encode(kitchenText(doc, key).toString()) : entry.slice();
}

type TextDiffHunk = { start: number; end: number; lines: string[] };

function splitTextLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function textDiffHunks(current: string[], next: string[]): TextDiffHunk[] {
  const lengths = Array.from({ length: current.length + 1 }, () => new Uint32Array(next.length + 1));
  for (let left = current.length - 1; left >= 0; left -= 1) {
    for (let right = next.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = current[left] === next[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const hunks: TextDiffHunk[] = [];
  let left = 0;
  let right = 0;
  let hunk: TextDiffHunk | null = null;
  const finish = (): void => {
    if (hunk) hunks.push(hunk);
    hunk = null;
  };
  const active = (): TextDiffHunk => {
    hunk ??= { start: left, end: left, lines: [] };
    return hunk;
  };

  while (left < current.length || right < next.length) {
    if (left < current.length && right < next.length && current[left] === next[right]) {
      finish();
      left += 1;
      right += 1;
    } else if (right < next.length && (left === current.length || lengths[left][right + 1] >= lengths[left + 1][right])) {
      active().lines.push(next[right]);
      right += 1;
    } else {
      active().end += 1;
      left += 1;
    }
  }
  finish();
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

export function writeKitchenText(doc: Y.Doc, path: string, next: string, origin?: unknown): void {
  const key = normalizeKitchenPath(path);
  if (!key) throw new Error("Cannot write the folder root.");
  const files = kitchenFiles(doc);
  doc.transact(() => {
    if (files.get(key) !== TEXT_MARK) files.set(key, TEXT_MARK);
    applyTextDiff(kitchenText(doc, key), next);
  }, origin);
}

export function writeKitchenBytes(doc: Y.Doc, path: string, bytes: Uint8Array, origin?: unknown): void {
  if (isTextPath(path)) {
    writeKitchenText(doc, path, decoder.decode(bytes), origin);
    return;
  }
  const key = normalizeKitchenPath(path);
  if (!key) throw new Error("Cannot write the folder root.");
  doc.transact(() => { kitchenFiles(doc).set(key, bytes.slice()); }, origin);
}

function deleteEntry(doc: Y.Doc, key: string): void {
  const files = kitchenFiles(doc);
  if (files.get(key) === TEXT_MARK) {
    const text = kitchenText(doc, key);
    if (text.length) text.delete(0, text.length);
  }
  files.delete(key);
}

/** Removes a file, or every file under a directory when `recursive` is set. Returns the removed paths. */
export function deleteKitchenPath(doc: Y.Doc, path: string, recursive = false, origin?: unknown): string[] {
  const key = normalizeKitchenPath(path);
  if (!key) throw new Error("Cannot remove the folder root.");
  const files = kitchenFiles(doc);
  if (files.has(key)) {
    doc.transact(() => { deleteEntry(doc, key); }, origin);
    return [key];
  }
  const prefix = `${key}/`;
  const children = [...files.keys()].filter((candidate) => candidate.startsWith(prefix));
  if (!children.length) throw new Error(`File not found: ${path}`);
  if (!recursive) throw new Error(`Directory is not empty: ${path}`);
  doc.transact(() => { for (const child of children) deleteEntry(doc, child); }, origin);
  return children;
}

function topLevelName(doc: Y.Doc, type: unknown): string | null {
  for (const [name, shared] of doc.share) if (shared === type) return name;
  return null;
}

/**
 * Calls `listener` after every transaction that touched kitchen files, with the affected
 * folder-relative paths and the transaction origin. Returns the unsubscribe function.
 */
export function observeKitchen(
  doc: Y.Doc,
  listener: (paths: Set<string>, origin: unknown) => void,
): () => void {
  const files = kitchenFiles(doc);
  const handler = (transaction: Y.Transaction): void => {
    const paths = new Set<string>();
    for (const [type, keys] of transaction.changed) {
      if ((type as unknown) === files) {
        for (const key of keys) if (key) paths.add(key);
        continue;
      }
      const name = topLevelName(doc, type);
      if (name?.startsWith(TEXT_PREFIX)) paths.add(name.slice(TEXT_PREFIX.length));
    }
    if (paths.size) listener(paths, transaction.origin);
  };
  doc.on("afterTransaction", handler);
  return () => doc.off("afterTransaction", handler);
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_LENGTH = 26;

/** 130 bits of randomness rendered as lowercase base32, so the link is unguessable and easy to read aloud. */
export function newKitchenId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ID_ALPHABET[byte % 32]).join("");
}

export function isKitchenId(value: string): boolean {
  return new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`).test(value);
}

/**
 * The kitchen id travels in the URL fragment, which browsers never send with the page request,
 * so it stays out of the static host's logs. The relay does see it as the room name.
 */
export function kitchenIdFromUrl(url: string | URL): string | null {
  const hash = new URL(url, "http://localhost").hash.replace(/^#/, "");
  const value = new URLSearchParams(hash).get("k") ?? "";
  return isKitchenId(value) ? value : null;
}

export function kitchenLink(origin: string, id: string, pathname = "/"): string {
  const url = new URL(pathname, origin);
  url.hash = `k=${id}`;
  return url.toString();
}

export function withKitchenHash(url: string, id: string): string {
  const parsed = new URL(url, "http://localhost");
  parsed.hash = `k=${id}`;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
