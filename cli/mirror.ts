import { watch, type FSWatcher } from "node:fs";
import { link, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  deleteKitchenPath,
  isKitchenId,
  isTextPath,
  kitchenFiles,
  observeKitchen,
  kitchenIdFromUrl,
  listKitchenPaths,
  readKitchenBytes,
  writeKitchenBytes,
  writeKitchenText,
} from "../src/kitchen/doc.js";

export const MIRROR_ORIGIN = Symbol("mep-mirror");

const DISK_EVENT_COALESCE_MS = 75;
const INITIAL_SYNC_DEADLINE_MS = 15_000;
const MAX_PATH_SYNC_RETRIES = 8;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type MergeHunk = {
  start: number;
  end: number;
  lines: string[];
};

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffHunks(base: string[], next: string[]): MergeHunk[] {
  const lengths = Array.from({ length: base.length + 1 }, () => new Uint32Array(next.length + 1));
  for (let left = base.length - 1; left >= 0; left -= 1) {
    for (let right = next.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = base[left] === next[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }

  const hunks: MergeHunk[] = [];
  let left = 0;
  let right = 0;
  let hunk: MergeHunk | null = null;
  const finishHunk = (): void => {
    if (hunk) hunks.push(hunk);
    hunk = null;
  };
  const currentHunk = (): MergeHunk => {
    hunk ??= { start: left, end: left, lines: [] };
    return hunk;
  };

  while (left < base.length || right < next.length) {
    if (left < base.length && right < next.length && base[left] === next[right]) {
      finishHunk();
      left += 1;
      right += 1;
    } else if (
      right < next.length
      && (left === base.length || lengths[left][right + 1] >= lengths[left + 1][right])
    ) {
      currentHunk().lines.push(next[right]);
      right += 1;
    } else {
      currentHunk().end += 1;
      left += 1;
    }
  }
  finishHunk();
  return hunks;
}

function hunksOverlap(left: MergeHunk, right: MergeHunk): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) return left.start === right.start;
  if (leftInsertion) return left.start > right.start && left.start < right.end;
  if (rightInsertion) return right.start > left.start && right.start < left.end;
  return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function mergePeerText(baseText: string, diskText: string, kitchenText: string): string {
  if (diskText === kitchenText) return diskText;
  if (diskText === baseText) return kitchenText;
  if (kitchenText === baseText) return diskText;

  const base = splitLines(baseText);
  const disk = diffHunks(base, splitLines(diskText));
  const kitchen: MergeHunk[] = [];
  for (const kitchenHunk of diffHunks(base, splitLines(kitchenText))) {
    const samePosition = disk.find((diskHunk) =>
      diskHunk.start === diskHunk.end
      && kitchenHunk.start === kitchenHunk.end
      && diskHunk.start === kitchenHunk.start,
    );
    if (samePosition) {
      const diskLines = new Set(samePosition.lines);
      samePosition.lines.push(...kitchenHunk.lines.filter((line) => !diskLines.has(line)));
    } else if (!disk.some((diskHunk) => hunksOverlap(diskHunk, kitchenHunk))) {
      kitchen.push(kitchenHunk);
    }
  }
  const hunks = [...disk, ...kitchen].sort((left, right) =>
    left.start - right.start
    || Number(left.start !== left.end) - Number(right.start !== right.end)
    || left.end - right.end,
  );

  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    output.push(...base.slice(cursor, hunk.start), ...hunk.lines);
    cursor = Math.max(cursor, hunk.end);
  }
  output.push(...base.slice(cursor));
  return output.join("");
}

type MirrorOptions = {
  folder: string;
  kitchen: string;
  relay: string;
  once?: boolean;
  log?: (line: string) => void;
  signal?: AbortSignal;
  now?: () => Date;
};

function kitchenId(value: string): string {
  const id = isKitchenId(value) ? value : kitchenIdFromUrl(value);
  if (!id) throw new Error("--kitchen needs a kitchen link or valid kitchen id");
  return id;
}

function skipped(relative: string, directory = false): boolean {
  const parts = relative.split("/");
  if (parts.includes(".git") || parts.includes("node_modules")) return true;
  return !directory && parts.at(-1)?.includes(".local-") === true;
}

function safeRelative(value: string): string {
  const relative = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = relative.split("/").filter(Boolean);
  if (!parts.length || path.isAbsolute(value) || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid mirrored path: ${value}`);
  }
  return parts.join("/");
}

function absolutePath(folder: string, relative: string): string {
  return path.join(folder, ...safeRelative(relative).split("/"));
}

async function rejectSymlinks(folder: string, relative: string): Promise<void> {
  let candidate = folder;
  for (const part of safeRelative(relative).split("/")) {
    candidate = path.join(candidate, part);
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info === null) return;
    if (info.isSymbolicLink()) throw new Error(`refusing to mirror symbolic link: ${relative}`);
  }
}

function equal(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function readOptional(file: string): Promise<Buffer | null> {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

let temporaryFileCounter = 0;
async function replaceFileIfCurrent(
  file: string,
  bytes: Uint8Array,
  expected: Uint8Array | null,
  stillCurrent: () => boolean,
): Promise<boolean> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.local-mirror-${process.pid}-${temporaryFileCounter++}`,
  );
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    if (!equal(await readOptional(file), expected) || !stillCurrent()) return false;
    if (expected === null) {
      try {
        await link(temporary, file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    }
    await rename(temporary, file);
    return true;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function unlinkIfCurrent(
  file: string,
  expected: Uint8Array,
  stillCurrent: () => boolean,
): Promise<boolean> {
  if (!equal(await readOptional(file), expected) || !stillCurrent()) return false;
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function diskFiles(folder: string, start = ""): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(relativeDirectory: string): Promise<void> {
    const directory = relativeDirectory ? absolutePath(folder, relativeDirectory) : folder;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (relativeDirectory && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipped(relative, true)) await walk(relative);
      } else if (entry.isFile() && !skipped(relative)) {
        await rejectSymlinks(folder, relative);
        const bytes = await readOptional(absolutePath(folder, relative));
        if (bytes !== null) files.set(relative, bytes);
      }
    }
  }
  await walk(start);
  return files;
}

function writeDoc(doc: Y.Doc, relative: string, bytes: Uint8Array): void {
  if (isTextPath(relative)) writeKitchenText(doc, relative, decoder.decode(bytes), MIRROR_ORIGIN);
  else writeKitchenBytes(doc, relative, bytes, MIRROR_ORIGIN);
}

function stamp(date: Date): string {
  const values = [
    date.getFullYear(), date.getMonth() + 1, date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds(),
  ];
  return values.map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0"))
    .slice(0, 3).join("") + "-" + values.slice(3).map((value) => String(value).padStart(2, "0")).join("");
}

function localCopyPath(file: string, now: Date): string {
  const parsed = path.parse(file);
  return path.join(parsed.dir, `${parsed.name}.local-${stamp(now)}${parsed.ext}`);
}

async function waitForInitialSync(provider: WebsocketProvider, signal: AbortSignal): Promise<boolean> {
  if (provider.synced) return true;
  return await new Promise<boolean>((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error("timed out waiting for the relay's initial sync")), INITIAL_SYNC_DEADLINE_MS);
    const onSync = (synced: boolean) => { if (synced) finish(); };
    const onAbort = () => finish(undefined, false);
    const onClosed = (event: { code: number; reason: string }) => {
      finish(new Error(`relay closed before initial sync (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
    };
    const finish = (error?: Error, synced = true): void => {
      clearTimeout(deadline);
      provider.off("sync", onSync);
      provider.off("closed", onClosed);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(synced);
    };
    provider.on("sync", onSync);
    provider.on("closed", onClosed);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function mirrorKitchen(options: MirrorOptions): Promise<void> {
  const id = kitchenId(options.kitchen);
  let relay: URL;
  try { relay = new URL(options.relay); }
  catch { throw new Error("--relay needs a valid ws:// or wss:// URL"); }
  if (relay.protocol !== "ws:" && relay.protocol !== "wss:") {
    throw new Error("--relay needs a valid ws:// or wss:// URL");
  }
  const requestedFolder = path.resolve(options.folder);
  const folder = await realpath(requestedFolder).catch(() => null);
  if (!folder || !(await stat(folder).catch(() => null))?.isDirectory()) {
    throw new Error(`folder not found: ${requestedFolder}`);
  }
  if (folder !== requestedFolder) {
    options.log?.(`resolved mirror folder ${requestedFolder} to ${folder}\n`);
  }

  const ownAbort = options.signal ? null : new AbortController();
  const signal = options.signal ?? ownAbort!.signal;
  const onSigint = () => ownAbort?.abort();
  if (ownAbort) process.once("SIGINT", onSigint);
  if (signal.aborted) {
    if (ownAbort) process.off("SIGINT", onSigint);
    return;
  }

  const doc = new Y.Doc();
  const provider = new WebsocketProvider(relay.toString(), id, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  let watcher: FSWatcher | null = null;
  let stopObserving: (() => void) | null = null;
  let monitoringProvider = false;
  const debounces = new Map<string, { timeout: NodeJS.Timeout; run: () => void }>();
  const files = kitchenFiles(doc);
  let fatal: unknown;
  let queue = Promise.resolve();
  let stopMirror: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { stopMirror = resolve; });
  const onAbort = () => stopMirror?.();
  signal.addEventListener("abort", onAbort, { once: true });
  const fail = (error: unknown): void => {
    if (fatal === undefined) fatal = error;
    stopMirror?.();
  };
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(task);
    queue = next.catch(fail);
    return next;
  };
  const log = (message: string, always = false): void => {
    if (!options.once || always) options.log?.(`${message}\n`);
  };

  const baselines = new Map<string, Uint8Array | null>();
  const rememberBaseline = (relative: string, bytes: Uint8Array | null): void => {
    baselines.set(relative, bytes?.slice() ?? null);
  };
  const preserveLocal = async (file: string, bytes: Uint8Array): Promise<string> => {
    const first = localCopyPath(file, options.now?.() ?? new Date());
    const extension = path.extname(first);
    const stem = first.slice(0, first.length - extension.length);
    for (let copy = 1; ; copy += 1) {
      const localCopy = copy === 1 ? first : `${stem}-${copy}${extension}`;
      try {
        await writeFile(localCopy, bytes, { flag: "wx" });
        return path.relative(folder, localCopy).split(path.sep).join("/");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  };

  const syncDocPathToDisk = async (relativeValue: string, attempt = 0): Promise<void> => {
    const relative = safeRelative(relativeValue);
    if (skipped(relative)) return;
    if (attempt > MAX_PATH_SYNC_RETRIES) {
      throw new Error(`mirror path kept changing during synchronization: ${relative}`);
    }
    const retry = (): Promise<void> => syncDocPathToDisk(relative, attempt + 1);
    const file = absolutePath(folder, relative);
    await rejectSymlinks(folder, relative);
    const docBytes = readKitchenBytes(doc, relative);
    const diskBytes = await readOptional(file);
    const docStillCurrent = (): boolean => equal(readKitchenBytes(doc, relative), docBytes);
    const baselineKnown = baselines.has(relative);
    const baseline = baselines.get(relative) ?? null;
    const localChanged = baselineKnown ? !equal(diskBytes, baseline) : diskBytes !== null;

    if (localChanged && diskBytes !== null) {
      if (docBytes !== null && isTextPath(relative)) {
        const merged = mergePeerText(
          baseline === null ? "" : decoder.decode(baseline),
          decoder.decode(diskBytes),
          decoder.decode(docBytes),
        );
        const mergedBytes = encoder.encode(merged);
        await mkdir(path.dirname(file), { recursive: true });
        await rejectSymlinks(folder, relative);
        if (!await replaceFileIfCurrent(file, mergedBytes, diskBytes, docStillCurrent)) return retry();
        if (!docStillCurrent()) return retry();
        writeKitchenText(doc, relative, merged, MIRROR_ORIGIN);
        const currentBytes = readKitchenBytes(doc, relative)!;
        rememberBaseline(relative, currentBytes);
        log(`merged local changes with kitchen for ${relative}`, true);
        return;
      }

      const preserved = await preserveLocal(file, diskBytes);
      if (docBytes === null) {
        if (!await unlinkIfCurrent(file, diskBytes, docStillCurrent)) return retry();
        if (!docStillCurrent()) return retry();
        rememberBaseline(relative, null);
        log(`deleted ${relative}; preserved local copy as ${preserved}`, true);
        return;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await rejectSymlinks(folder, relative);
      if (!await replaceFileIfCurrent(file, docBytes, diskBytes, docStillCurrent)) return retry();
      if (!docStillCurrent()) return retry();
      rememberBaseline(relative, docBytes);
      log(`wrote ${relative}; preserved local copy as ${preserved}`, true);
      return;
    }

    if (docBytes === null) {
      if (diskBytes !== null) {
        if (!await unlinkIfCurrent(file, diskBytes, docStillCurrent)) return retry();
        if (!docStillCurrent()) return retry();
        log(`deleted ${relative}`);
      }
      rememberBaseline(relative, null);
      return;
    }
    if (equal(docBytes, diskBytes)) {
      rememberBaseline(relative, docBytes);
      return;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await rejectSymlinks(folder, relative);
    if (!await replaceFileIfCurrent(file, docBytes, diskBytes, docStillCurrent)) return retry();
    if (!docStillCurrent()) return retry();
    rememberBaseline(relative, docBytes);
    if (localChanged) log(`restored ${relative}; local deletion conflicted with kitchen change`, true);
    else log(`wrote ${relative}`);
  };

  const deleteDocPath = (relative: string): void => {
    if (files.has(relative) || [...files.keys()].some((key) => key.startsWith(`${relative}/`))) {
      deleteKitchenPath(doc, relative, true, MIRROR_ORIGIN);
      log(`removed ${relative} from kitchen`);
    }
  };

  const syncDiskFileToDoc = async (relative: string, bytes: Uint8Array): Promise<void> => {
    const docBytes = readKitchenBytes(doc, relative);
    if (equal(bytes, docBytes)) {
      rememberBaseline(relative, bytes);
      return;
    }
    if (docBytes !== null) {
      await syncDocPathToDisk(relative);
      return;
    }
    writeDoc(doc, relative, bytes);
    rememberBaseline(relative, bytes);
    log(`updated kitchen from ${relative}`);
  };

  const syncDiskDeletionToDoc = async (relative: string): Promise<void> => {
    const docBytes = readKitchenBytes(doc, relative);
    const baselineKnown = baselines.has(relative);
    const baseline = baselines.get(relative) ?? null;
    if (docBytes !== null && (!baselineKnown || !equal(docBytes, baseline))) {
      await syncDocPathToDisk(relative);
      return;
    }
    deleteDocPath(relative);
    rememberBaseline(relative, null);
  };

  const syncDiskPathToDoc = async (relativeValue: string): Promise<void> => {
    const relative = safeRelative(relativeValue);
    if (skipped(relative)) return;
    const file = absolutePath(folder, relative);
    await rejectSymlinks(folder, relative);
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isFile()) {
      await syncDiskFileToDoc(relative, await readFile(file));
      return;
    }
    if (info?.isDirectory()) {
      const found = await diskFiles(folder, relative);
      for (const [filePath, bytes] of found) await syncDiskFileToDoc(filePath, bytes);
      const prefix = `${relative}/`;
      for (const docPath of listKitchenPaths(doc)) {
        if (docPath.startsWith(prefix) && !found.has(docPath)) {
          await syncDiskDeletionToDoc(docPath);
        }
      }
      return;
    }
    const missing = listKitchenPaths(doc).filter(
      (docPath) => docPath === relative || docPath.startsWith(`${relative}/`),
    );
    if (missing.length === 0) rememberBaseline(relative, null);
    for (const docPath of missing) await syncDiskDeletionToDoc(docPath);
  };

  const syncAllDiskPathsToDoc = async (): Promise<void> => {
    const disk = await diskFiles(folder);
    for (const filePath of new Set([...disk.keys(), ...listKitchenPaths(doc)])) {
      if (!skipped(filePath)) await syncDiskPathToDoc(filePath);
    }
  };
  const pendingDiskPaths = new Set<string>();
  let diskDrainQueued = false;
  const scheduleDiskPath = (relative?: string): void => {
    pendingDiskPaths.add(relative ?? "");
    if (diskDrainQueued) return;
    diskDrainQueued = true;
    enqueue(async () => {
      try {
        while (pendingDiskPaths.size) {
          const paths = [...pendingDiskPaths];
          pendingDiskPaths.clear();
          if (paths.includes("")) await syncAllDiskPathsToDoc();
          else for (const changed of paths) await syncDiskPathToDoc(changed);
        }
      } finally {
        diskDrainQueued = false;
      }
    });
  };

  const reconcile = async (): Promise<void> => {
    const disk = await diskFiles(folder);
    const paths = new Set([...disk.keys(), ...listKitchenPaths(doc)]);
    for (const relative of paths) {
      if (skipped(relative)) continue;
      if (readKitchenBytes(doc, relative) === null) await syncDiskPathToDoc(relative);
      else await syncDocPathToDisk(relative);
    }
  };

  const pendingDocPaths = new Set<string>();
  let docDrainQueued = false;
  const scheduleDocPath = (relative: string): void => {
    pendingDocPaths.add(relative);
    if (docDrainQueued) return;
    docDrainQueued = true;
    enqueue(async () => {
      try {
        while (pendingDocPaths.size) {
          const paths = [...pendingDocPaths];
          pendingDocPaths.clear();
          for (const changed of paths) await syncDocPathToDisk(changed);
        }
      } finally {
        docDrainQueued = false;
      }
    });
  };
  const observeDoc = (paths: Set<string>, origin: unknown): void => {
    if (origin === MIRROR_ORIGIN) return;
    for (const relative of paths) scheduleDocPath(relative);
  };
  const onProviderClosed = (event: { code: number; reason: string }): void => {
    fail(new Error(`relay closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`));
  };

  try {
    if (!await waitForInitialSync(provider, signal)) return;
    if (options.once) {
      await reconcile();
      return;
    }

    stopObserving = observeKitchen(doc, observeDoc);
    provider.on("closed", onProviderClosed);
    monitoringProvider = true;
    watcher = watch(folder, { recursive: true }, (_event, filename) => {
      const relative = filename?.toString().replace(/\\/g, "/");
      if (relative && skipped(relative)) return;
      const key = relative || ".";
      const current = debounces.get(key);
      if (current) clearTimeout(current.timeout);
      const run = (): void => {
        debounces.delete(key);
        scheduleDiskPath(relative);
      };
      debounces.set(key, { timeout: setTimeout(run, DISK_EVENT_COALESCE_MS), run });
    });
    watcher.on("error", fail);
    await enqueue(reconcile);
    await stopped;
  } finally {
    watcher?.close();
    for (const pending of [...debounces.values()]) {
      clearTimeout(pending.timeout);
      pending.run();
    }
    await queue;
    provider.disconnect();
    if (monitoringProvider) provider.off("closed", onProviderClosed);
    signal.removeEventListener("abort", onAbort);
    await queue;
    stopObserving?.();
    provider.destroy();
    doc.destroy();
    if (ownAbort) process.off("SIGINT", onSigint);
  }
  if (fatal !== undefined) throw fatal;
}
