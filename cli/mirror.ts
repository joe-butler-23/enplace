import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, realpath, rename, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import {
  deleteCookbookPath, hasCookbookDirectory, hasCookbookFile, isCookbookId, isTextPath, cookbookIdFromUrl,
  listCookbookPaths, observeCookbook, readCookbookBytes, writeCookbookBytes, writeCookbookText,
} from "../src/cookbook/doc.js";
import { mergeText } from "../src/cookbook/merge.js";
import {
  atomicCommit, createPrivateOperation, equal, optionalLstat, privateDirectory, readOptional, unlinkIfPresent,
  writePrivateFile, type Bytes,
} from "./mirror-commit.js";

export const MIRROR_ORIGIN = Symbol("mep-mirror");
const INITIAL_SYNC_DEADLINE_MS = 15_000;
const MAX_PATH_SYNC_RETRIES = 8;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type MirrorOptions = {
  folder: string; cookbook?: string; relay?: string; once?: boolean;
  log?: (line: string) => void; signal?: AbortSignal; now?: () => Date;
};
type MirrorAssociation = { version: 1; cookbook: string; relay: string };
type MirrorState = { association: MirrorAssociation | null; baselines: Map<string, Bytes> };
const ASSOCIATION_FILE = "association.json";
const BASELINES_DIRECTORY = "baselines";
async function cleanupPrivateRoot(privateRoot: string, parent: string): Promise<void> {
  const operations = await readdir(privateRoot, { withFileTypes: true });
  for (const operationEntry of operations) {
    if (!operationEntry.isDirectory() || operationEntry.isSymbolicLink() || !operationEntry.name.startsWith("operation-")) continue;
    const operation = path.join(privateRoot, operationEntry.name);
    const entries = await readdir(operation, { withFileTypes: true });
    const replacement = entries.find((entry) => entry.isFile() && entry.name === "replacement");
    const recoveries = entries.filter((entry) => entry.isFile() && /\.local-\d{8}-\d{6}(\..*)?$/.test(entry.name));
    if (replacement && recoveries.length === 1) {
      const match = /^(.*)\.local-\d{8}-\d{6}(\..*)?$/.exec(recoveries[0].name);
      const publicBytes = match ? await readOptional(path.join(parent, `${match[1]}${match[2] ?? ""}`)) : null;
      const stagedBytes = await readOptional(path.join(operation, replacement.name));
      if (publicBytes !== null && equal(publicBytes, stagedBytes)) await unlinkIfPresent(path.join(operation, replacement.name));
    }
    if ((await readdir(operation)).length === 0) await rmdir(operation);
  }
}

export async function cleanupReplacementScratch(folder: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === ".mep-mirror") await cleanupPrivateRoot(child, directory);
      else await visit(child);
    }
  };
  await visit(folder);
}

export function createPathScheduler(run: (paths: readonly string[]) => Promise<void>, onError: (error: unknown) => void) {
  const pending = new Set<string>();
  let accepting = true;
  let draining = false;
  let tail = Promise.resolve();
  const schedule = (relative = ""): void => {
    if (!accepting) return;
    pending.add(relative);
    if (draining) return;
    draining = true;
    tail = tail.then(async () => {
      try {
        while (pending.size) {
          const paths = [...pending];
          pending.clear();
          await run(paths);
        }
      } catch (error) {
        accepting = false;
        pending.clear();
        onError(error);
      } finally { draining = false; }
    });
  };
  const stop = (): void => { accepting = false; };
  return { schedule, stop, close: async () => { stop(); await tail; }, idle: () => tail };
}

type Decision = "equal" | "local" | "remote" | "conflict";

function cookbookId(value: string): string {
  const id = isCookbookId(value) ? value : cookbookIdFromUrl(value);
  if (!id) throw new Error("--cookbook needs a cookbook link or valid cookbook id");
  return id;
}
function skipped(relative: string): boolean {
  const parts = relative.split("/");
  return parts.includes(".git") || parts.includes("node_modules") || parts.includes(".mep-mirror");
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
function relayUrl(value: string): string {
  let relay: URL;
  try { relay = new URL(value); }
  catch { throw new Error("--relay needs a valid ws:// or wss:// URL"); }
  if (relay.protocol !== "ws:" && relay.protocol !== "wss:") {
    throw new Error("--relay needs a valid ws:// or wss:// URL");
  }
  return relay.toString();
}
function baselineFileName(relative: string): string {
  return `${createHash("sha256").update(relative).digest("hex")}.json`;
}
async function readStateFile(file: string, label: string): Promise<Buffer | null> {
  const info = await optionalLstat(file);
  if (info === null) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`refusing invalid mirror ${label}: ${file}`);
  return readOptional(file);
}
function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`invalid mirror ${label}`); }
}
function parseAssociation(bytes: Buffer): MirrorAssociation {
  const value = parseJson(bytes, "association") as Partial<MirrorAssociation>;
  if (!value || value.version !== 1 || typeof value.cookbook !== "string" || typeof value.relay !== "string") {
    throw new Error("invalid mirror association");
  }
  let id: string;
  let relay: string;
  try { id = cookbookId(value.cookbook); relay = relayUrl(value.relay); }
  catch { throw new Error("invalid mirror association"); }
  if (id !== value.cookbook || relay !== value.relay) throw new Error("invalid mirror association");
  return { version: 1, cookbook: id, relay };
}
async function loadMirrorState(folder: string): Promise<MirrorState> {
  const privateRoot = path.join(folder, ".mep-mirror");
  const rootInfo = await optionalLstat(privateRoot);
  if (rootInfo === null) return { association: null, baselines: new Map() };
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`refusing invalid mirror recovery directory: ${privateRoot}`);
  }
  const associationBytes = await readStateFile(path.join(privateRoot, ASSOCIATION_FILE), "association file");
  const baselineRoot = path.join(privateRoot, BASELINES_DIRECTORY);
  const baselineInfo = await optionalLstat(baselineRoot);
  if (baselineInfo !== null && (baselineInfo.isSymbolicLink() || !baselineInfo.isDirectory())) {
    throw new Error(`refusing invalid mirror baselines directory: ${baselineRoot}`);
  }
  if (!associationBytes && baselineInfo !== null) throw new Error("mirror baselines exist without an association");
  const association = associationBytes ? parseAssociation(associationBytes) : null;
  const baselines = new Map<string, Bytes>();
  if (baselineInfo !== null) {
    for (const entry of await readdir(baselineRoot, { withFileTypes: true })) {
      const file = path.join(baselineRoot, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        throw new Error(`refusing invalid mirror baseline: ${file}`);
      }
      const bytes = await readStateFile(file, "baseline file");
      if (!bytes) throw new Error(`invalid mirror baseline: ${file}`);
      const value = parseJson(bytes, "baseline") as { version?: unknown; path?: unknown; base64?: unknown };
      if (!value || value.version !== 1 || typeof value.path !== "string"
          || !(value.base64 === null || typeof value.base64 === "string")) {
        throw new Error(`invalid mirror baseline: ${file}`);
      }
      let relative: string;
      try { relative = safeRelative(value.path); }
      catch { throw new Error(`invalid mirror baseline: ${file}`); }
      if (relative !== value.path || entry.name !== baselineFileName(relative) || baselines.has(relative)) {
        throw new Error(`invalid mirror baseline: ${file}`);
      }
      let baseline: Bytes = null;
      if (typeof value.base64 === "string") {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
          throw new Error(`invalid mirror baseline: ${file}`);
        }
        baseline = Buffer.from(value.base64, "base64");
        if (Buffer.from(baseline).toString("base64") !== value.base64) throw new Error(`invalid mirror baseline: ${file}`);
      }
      baselines.set(relative, baseline);
    }
  }
  return { association, baselines };
}
async function saveAssociation(folder: string, association: MirrorAssociation): Promise<void> {
  const privateRoot = await privateDirectory(folder, [".mep-mirror"], "mirror state");
  const file = path.join(privateRoot, ASSOCIATION_FILE);
  const bytes = encoder.encode(`${JSON.stringify(association)}\n`);
  const result = await writePrivateFile(file, bytes, "keep");
  if (result === "written") return;
  const existing = await readStateFile(file, "association file");
  if (!existing || !equal(existing, bytes)) throw new Error("mirror folder association changed concurrently");
}
async function saveBaseline(folder: string, relative: string, bytes: Bytes): Promise<void> {
  const baselineRoot = await privateDirectory(folder, [".mep-mirror", BASELINES_DIRECTORY], "mirror state");
  const value = { version: 1, path: relative, base64: bytes === null ? null : Buffer.from(bytes).toString("base64") };
  await writePrivateFile(path.join(baselineRoot, baselineFileName(relative)), encoder.encode(`${JSON.stringify(value)}\n`));
}
async function rejectSymlinks(folder: string, relative: string): Promise<void> {
  let candidate = folder;
  for (const part of safeRelative(relative).split("/")) {
    candidate = path.join(candidate, part);
    const info = await optionalLstat(candidate);
    if (info === null) return;
    if (info.isSymbolicLink()) throw new Error(`refusing to mirror symbolic link: ${relative}`);
  }
}
function reconciliationDecision(
  baselineKnown: boolean, baseline: Bytes, local: Bytes, remote: Bytes,
): Decision {
  if (equal(local, remote)) return "equal";
  if (!baselineKnown) return local === null ? "remote" : remote === null ? "local" : "conflict";
  const localChanged = !equal(local, baseline);
  const remoteChanged = !equal(remote, baseline);
  if (localChanged && remoteChanged) return "conflict";
  return localChanged ? "local" : "remote";
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
      if (entry.isDirectory() && !skipped(relative)) await walk(relative);
      else if (entry.isFile() && !skipped(relative)) {
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
  if (isTextPath(relative)) writeCookbookText(doc, relative, decoder.decode(bytes), MIRROR_ORIGIN);
  else writeCookbookBytes(doc, relative, new Uint8Array(bytes), MIRROR_ORIGIN);
}
export function localCopyPath(file: string, now: Date): string {
  const parsed = path.parse(file);
  const values = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()];
  const padded = values.map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0"));
  const stamp = `${padded.slice(0, 3).join("")}-${padded.slice(3).join("")}`;
  return path.join(parsed.dir, `${parsed.name}.local-${stamp}${parsed.ext}`);
}
type DiskPlan = { desired: Bytes; message: string; merged?: string };
export function diskPlan(
  relative: string, decision: Decision, known: boolean, baseline: Bytes,
  local: Bytes, remote: Bytes,
): DiskPlan {
  if (decision === "conflict" && local !== null && remote !== null && isTextPath(relative)) {
    const merged = mergeText(decoder.decode(baseline ?? new Uint8Array()), decoder.decode(local), decoder.decode(remote));
    const plural = merged.conflicts === 1 ? "" : "s";
    const detail = merged.conflicts ? `; kept ${merged.conflicts} conflict${plural}` : "";
    return { desired: encoder.encode(merged.text), merged: merged.text, message: `merged local changes with cookbook for ${relative}${detail}` };
  }
  let message = `wrote ${relative}`;
  if (local === null && known && baseline !== null) {
    message = `restored ${relative}; local deletion conflicted with cookbook change`;
  } else if (remote === null) message = `deleted ${relative}`;
  return { desired: remote, message };
}
async function waitForInitialSync(provider: WebsocketProvider, signal: AbortSignal): Promise<boolean> {
  if (provider.synced) return true;
  return await new Promise<boolean>((resolve, reject) => {
    const deadline = setTimeout(() => finish(new Error("timed out waiting for the relay's initial sync")), INITIAL_SYNC_DEADLINE_MS);
    const onSync = (synced: boolean) => { if (synced) finish(); };
    const onAbort = () => finish(undefined, false);
    const onClosed = (event: { code: number; reason: string }) => finish(new Error(
      `relay closed before initial sync (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
    ));
    const finish = (error?: Error, synced = true): void => {
      clearTimeout(deadline); provider.off("sync", onSync); provider.off("closed", onClosed);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(synced);
    };
    provider.on("sync", onSync); provider.on("closed", onClosed);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}



export async function mirrorCookbook(options: MirrorOptions): Promise<void> {
  const requestedFolder = path.resolve(options.folder);
  const folder = await realpath(requestedFolder).catch(() => null);
  if (!folder || !(await stat(folder).catch(() => null))?.isDirectory()) {
    throw new Error(`folder not found: ${requestedFolder}`);
  }
  if (path.dirname(folder) === folder) throw new Error("refusing to mirror a filesystem root");
  if (folder !== requestedFolder) options.log?.(`resolved mirror folder ${requestedFolder} to ${folder}\n`);
  const state = await loadMirrorState(folder);
  const requestedCookbook = options.cookbook === undefined ? undefined : cookbookId(options.cookbook);
  const requestedRelay = options.relay === undefined ? undefined : relayUrl(options.relay);
  if (state.association && requestedCookbook && requestedCookbook !== state.association.cookbook) {
    throw new Error("mirror folder is already associated with a different cookbook");
  }
  if (state.association && requestedRelay && requestedRelay !== state.association.relay) {
    throw new Error("mirror folder is already associated with a different relay");
  }
  const id = requestedCookbook ?? state.association?.cookbook;
  const relay = requestedRelay ?? state.association?.relay;
  if (!id) throw new Error("mirror needs --cookbook <link-or-id> for an unassociated folder");
  if (!relay) throw new Error("mirror needs --relay <wss-url> or ENPLACE_RELAY_URL for an unassociated folder");
  const association: MirrorAssociation = { version: 1, cookbook: id, relay };
  const needsAssociation = state.association === null;

  const ownAbort = options.signal ? null : new AbortController();
  const signal = options.signal ?? ownAbort!.signal;
  const onSigint = () => ownAbort?.abort();
  if (ownAbort) process.once("SIGINT", onSigint);
  if (signal.aborted) { if (ownAbort) process.off("SIGINT", onSigint); return; }

  const doc = new Y.Doc();
  const provider = new WebsocketProvider(relay, id, doc, { disableBc: true });
  let watcher: FSWatcher | null = null;
  let stopObserving: (() => void) | null = null;
  const baselines = state.baselines;
  let fatal: unknown;
  let scheduler: ReturnType<typeof createPathScheduler> | null = null;
  let stopMirror: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { stopMirror = resolve; });
  const fail = (error: unknown): void => {
    if (fatal === undefined) fatal = error;
    scheduler?.stop();
    stopMirror?.();
  };
  const log = (message: string, always = false): void => {
    if (!options.once || always) options.log?.(`${message}\n`);
  };
  const remember = async (relative: string, bytes: Bytes): Promise<void> => {
    if (baselines.has(relative) && equal(baselines.get(relative) ?? null, bytes)) return;
    await saveBaseline(folder, relative, bytes);
    baselines.set(relative, bytes === null ? null : new Uint8Array(bytes));
  };
  const deleteDoc = (relative: string): void => {
    if (hasCookbookFile(doc, relative) || hasCookbookDirectory(doc, relative)) {
      deleteCookbookPath(doc, relative, true, MIRROR_ORIGIN);
      log(`removed ${relative} from cookbook`);
    }
  };
  const applyLocal = async (relative: string, local: Bytes): Promise<void> => {
    if (local === null) deleteDoc(relative);
    else { writeDoc(doc, relative, local); log(`updated cookbook from ${relative}`); }
    await remember(relative, local);
  };

  const reconcilePath = async (relativeValue: string): Promise<void> => {
    const relative = safeRelative(relativeValue);
    if (skipped(relative)) return;
    const recoveries: string[] = [];
    const recoverySuffix = (): string => recoveries
      .map((file) => `; preserved local copy as ${path.relative(folder, file).split(path.sep).join("/")}`).join("");
    const reportRecoveries = (): void => { if (recoveries.length) log(`retained local recovery${recoverySuffix()}`, true); };
    for (let attempt = 0; attempt <= MAX_PATH_SYNC_RETRIES; attempt += 1) {
      const file = absolutePath(folder, relative);
      await rejectSymlinks(folder, relative);
      const remote = readCookbookBytes(doc, relative);
      const local = await readOptional(file);
      const known = baselines.has(relative);
      const baseline = baselines.get(relative) ?? null;
      const decision = reconciliationDecision(known, baseline, local, remote);
      if (!equal(readCookbookBytes(doc, relative), remote)) continue;
      if (decision === "equal") { await remember(relative, remote); reportRecoveries(); return; }
      if (decision === "local") { await applyLocal(relative, local); reportRecoveries(); return; }
      const plan = diskPlan(relative, decision, known, baseline, local, remote);
      if (plan.desired !== null) {
        await mkdir(path.dirname(file), { recursive: true });
        await rejectSymlinks(folder, relative);
      }
      const committed = await atomicCommit(file, local, plan.desired, {
        current: () => equal(readCookbookBytes(doc, relative), remote),
        recoveryName: path.basename(localCopyPath(file, options.now?.() ?? new Date())),
      });
      if (committed.recovery && !recoveries.includes(committed.recovery)) recoveries.push(committed.recovery);
      if (committed.result === "committed") {
        if (plan.merged) writeCookbookText(doc, relative, plan.merged, MIRROR_ORIGIN);
        await remember(relative, plan.desired);
        log(`${plan.message}${recoverySuffix()}`, decision === "conflict" || plan.message.startsWith("restored"));
        return;
      }
    }
    throw new Error(`mirror path kept changing during synchronization: ${relative}${recoverySuffix()}`);
  };

  const preservePath = async (relative: string): Promise<string> => {
    await rejectSymlinks(folder, relative);
    const file = absolutePath(folder, relative);
    const operation = await createPrivateOperation(path.dirname(file));
    const recovery = path.join(operation, path.basename(localCopyPath(file, options.now?.() ?? new Date())));
    await rename(file, recovery);
    return path.relative(folder, recovery).split(path.sep).join("/");
  };
  const replaceBlockingDirectory = async (relative: string): Promise<void> => {
    const recovery = await preservePath(relative);
    log(`restored ${relative}; preserved blocking directory as ${recovery}`, true);
    await reconcilePath(relative);
  };

  const reconcileChangedPath = async (relativeValue: string): Promise<void> => {
    const relative = safeRelative(relativeValue);
    if (skipped(relative)) return;
    await rejectSymlinks(folder, relative);
    const info = await optionalLstat(absolutePath(folder, relative));
    if (!info?.isDirectory()) {
      const paths = listCookbookPaths(doc).filter((key) => key === relative || key.startsWith(`${relative}/`));
      if (info?.isFile() || paths.length === 0) await reconcilePath(relative);
      else for (const key of paths) await reconcilePath(key);
      return;
    }
    if (hasCookbookFile(doc, relative)) {
      await replaceBlockingDirectory(relative);
      return;
    }
    const found = await diskFiles(folder, relative);
    const remote = listCookbookPaths(doc).filter((value) => value.startsWith(`${relative}/`));
    for (const key of new Set([...found.keys(), ...remote])) await reconcilePath(key);
  };
  const reconcileAll = async (): Promise<void> => {
    const remote = listCookbookPaths(doc);
    let disk = await diskFiles(folder);
    for (const relative of disk.keys()) {
      if (hasCookbookDirectory(doc, relative) && !hasCookbookFile(doc, relative)) {
        const recovery = await preservePath(relative);
        log(`preserved file blocking projected directory ${relative} as ${recovery}`, true);
      }
    }
    for (const relative of remote) {
      await rejectSymlinks(folder, relative);
      if ((await optionalLstat(absolutePath(folder, relative)))?.isDirectory()) {
        await replaceBlockingDirectory(relative);
      }
    }
    disk = await diskFiles(folder);
    for (const relative of disk.keys()) {
      if (!remote.includes(relative) && / \(file conflict [0-9a-f]{8}(?:-[0-9]+)?\)(?:\.[^/]+)?$/.test(relative)) {
        const recovery = await preservePath(relative);
        log(`preserved stale projected path ${relative} as ${recovery}`, true);
      }
    }
    disk = await diskFiles(folder);
    for (const relative of new Set([...disk.keys(), ...remote, ...baselines.keys()])) await reconcilePath(relative);
  };
  scheduler = createPathScheduler(async (paths) => {
    if (paths.includes("")) await reconcileAll();
    else for (const changed of paths) await reconcileChangedPath(changed);
  }, fail);
  const { schedule } = scheduler;
  const onProviderClosed = (event: { code: number; reason: string }): void => fail(new Error(
    `relay closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
  ));
  const onAbort = (): void => { scheduler?.stop(); stopMirror?.(); };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (!await waitForInitialSync(provider, signal)) return;
    if (needsAssociation) await saveAssociation(folder, association);
    if (options.once) { await reconcileAll(); await cleanupReplacementScratch(folder); return; }
    stopObserving = observeCookbook(doc, (paths, origin) => {
      if (origin !== MIRROR_ORIGIN) for (const relative of paths) schedule(relative);
    });
    provider.on("closed", onProviderClosed);
    watcher = watch(folder, { recursive: true }, (_event, filename) => {
      const relative = filename?.toString().replace(/\\/g, "/");
      if (relative && skipped(relative)) return;
      schedule(relative);
    });
    watcher.on("error", fail);
    schedule();
    await scheduler.idle();
    await cleanupReplacementScratch(folder);
    await stopped;
  } finally {
    scheduler.stop();
    watcher?.close();
    stopObserving?.();
    provider.off("closed", onProviderClosed);
    signal.removeEventListener("abort", onAbort);
    await scheduler.close();
    provider.disconnect();
    provider.destroy();
    doc.destroy();
    if (ownAbort) process.off("SIGINT", onSigint);
  }
  if (fatal !== undefined) throw fatal;
}
