import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { watch as watchDirectory, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import { deleteCookbookPath, newCookbookId, readCookbookBytes, readCookbookText, writeCookbookBytes, writeCookbookText } from "../src/cookbook/doc";
import { execute } from "./index";
import { atomicCommit } from "./mirror-commit";
import { createPathScheduler, diskPlan, localCopyPath, mirrorCookbook } from "./mirror";
import { MirrorTestFixture, waitFor } from "./mirror-test-support";

const harness = new MirrorTestFixture();
const controllers: AbortController[] = [];
const mirrors: Promise<string>[] = [];
const encoder = new TextEncoder();
const fixedNow = new Date(2026, 8, 10, 12, 34, 56);
const currentCommit = { current: () => true, recoveryName: "cover.local-20260910-123456.webp" };
let relay: string;
type Client = Awaited<ReturnType<typeof harness.client>>;
type MirrorFixture = { root: string; target: string; cookbook: string; client: Client };
type StartOptions = { log?: (line: string) => void; now?: Date };
const folder = (): Promise<string> => harness.folder();
const syncedClient = (cookbook: string): Promise<Client> => harness.client(cookbook);

async function remoteFile(relative: string, contents: string | Uint8Array): Promise<Pick<MirrorFixture, "cookbook" | "client">> {
  const cookbook = newCookbookId();
  const client = await syncedClient(cookbook);
  const bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
  writeCookbookBytes(client.doc, relative, bytes);
  const verifier = await syncedClient(cookbook);
  expect(readCookbookBytes(verifier.doc, relative)).toEqual(bytes);
  verifier.provider.destroy();
  verifier.doc.destroy();
  return { cookbook, client };
}
async function binaryConflict(relative = "cover.webp", local = "local bytes", remote = "shared bytes"): Promise<MirrorFixture> {
  const root = await folder();
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, local);
  return { root, target, ...await remoteFile(relative, remote) };
}
async function recoveryFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.parentPath.split(path.sep).includes(".mep-mirror"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}
async function recoveryWith(root: string, contents: string | Uint8Array): Promise<string> {
  const expected = typeof contents === "string" ? encoder.encode(contents) : contents;
  const matches = (await recoveryFiles(root)).filter((file) =>
    file.split(path.sep).some((part) => /\.local-\d{8}-\d{6}/.test(part)));
  expect(matches).toHaveLength(1);
  expect(Buffer.from(await readFile(matches[0])).equals(Buffer.from(expected))).toBe(true);
  return matches[0];
}
function startMirror(root: string, cookbook: string, options: StartOptions = {}): void {
  const controller = new AbortController();
  controllers.push(controller);
  mirrors.push(execute(["mirror", "--folder", root, "--cookbook", cookbook, "--relay", relay], { ...options, signal: controller.signal }));
}
async function startedMirrorFile(relative: string, contents: string | Uint8Array, options: StartOptions = {}): Promise<MirrorFixture> {
  const root = await folder();
  const cookbook = newCookbookId();
  const client = await syncedClient(cookbook);
  const target = path.join(root, ...relative.split("/"));
  const bytes = typeof contents === "string" ? encoder.encode(contents) : contents;
  startMirror(root, cookbook, options);
  writeCookbookBytes(client.doc, relative, bytes);
  await waitFor(async () => expect(new Uint8Array(await readFile(target))).toEqual(bytes));
  return { root, target, cookbook, client };
}
async function mirrorOnce(root: string, cookbook: string, options: StartOptions = {}): Promise<void> {
  await execute(["mirror", "--folder", root, "--cookbook", cookbook, "--relay", relay, "--once"], options);
}
beforeAll(async () => { await harness.start(); relay = harness.relay; });
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(mirrors.splice(0));
  await harness.cleanup();
});
afterAll(async () => harness.close());

describe("mep mirror", () => {
  it("projects a disconnected file/descendant collision without losing bytes", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const client = await syncedClient(cookbook);
    writeCookbookText(client.doc, "recipes.md", "parent text\n");
    const offline = new Y.Doc();
    writeCookbookBytes(offline, "recipes.md/nested/cover.webp", new Uint8Array([0, 255, 7]));
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(offline));
    await mirrorOnce(root, cookbook);
    await expect(readFile(path.join(root, "recipes (file conflict 0ed49ba7).md"), "utf8"))
      .resolves.toBe("parent text\n");
    await expect(readFile(path.join(root, "recipes.md/nested/cover.webp")))
      .resolves.toEqual(Buffer.from([0, 255, 7]));
  });
  it("rejects a resolved filesystem root before relay work or traversal", async () => {
    const linkedRoot = path.join(await folder(), "filesystem-root");
    await symlink(path.parse(process.cwd()).root, linkedRoot, "dir");
    await expect(mirrorCookbook({ folder: linkedRoot, cookbook: newCookbookId(), relay: "not a relay" })).rejects.toThrow("refusing to mirror a filesystem root");
  });
  it.each(["README", ".env"])("places a recovery timestamp correctly in %s", (original) =>
    expect(path.basename(localCopyPath(original, fixedNow))).toBe(`${original}.local-20260910-123456`));
  it("applies a non-UTF8 local binary edit to the cookbook without another recovery", async () => {
    const initial = Uint8Array.from([0xff, 0x00, 0x80]);
    const changed = Uint8Array.from([0x80, 0x00, 0xff, 0x01]);
    const { root, target, client } = await startedMirrorFile("images/cover.webp", initial);
    const before = await recoveryFiles(root);
    await waitFor(async () => expect(readdir(path.join(path.dirname(target), ".mep-mirror"))).resolves.toEqual([]));
    await writeFile(target, changed);
    await waitFor(() => expect(readCookbookBytes(client.doc, "images/cover.webp")).toEqual(changed));
    expect(await recoveryFiles(root)).toEqual(before);
  });
  it("refuses an intermediate symlink before touching an outside blocking directory", async () => {
    const root = await folder();
    const outside = await folder();
    const blocking = path.join(outside, "soup.md");
    const kept = path.join(blocking, "kept.bin");
    await mkdir(blocking);
    await writeFile(kept, new Uint8Array([0, 255, 7]));
    await chmod(blocking, 0o750);
    await chmod(kept, 0o640);
    await symlink(outside, path.join(root, "recipes"));
    const { cookbook } = await remoteFile("recipes/soup.md", "# Soup\n");
    await expect(mirrorOnce(root, cookbook)).rejects.toThrow("refusing to mirror symbolic link: recipes/soup.md");
    expect(await readdir(outside)).toEqual(["soup.md"]);
    expect(await readdir(blocking)).toEqual(["kept.bin"]);
    expect(new Uint8Array(await readFile(kept))).toEqual(new Uint8Array([0, 255, 7]));
    expect((await stat(blocking)).mode & 0o777).toBe(0o750);
    expect((await stat(kept)).mode & 0o777).toBe(0o640);
    await expect(stat(path.join(outside, ".mep-mirror"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not rewrite or preserve an equal pre-existing binary after restart", async () => {
    const root = await folder();
    const target = path.join(root, "cover.webp");
    const bytes = Uint8Array.from([0, 255, 17, 0, 93]);
    await writeFile(target, bytes);
    const before = await stat(target, { bigint: true });
    const { cookbook } = await remoteFile("cover.webp", bytes);
    const logs: string[] = [];
    await mirrorOnce(root, cookbook, { log: (line) => logs.push(line) });
    const after = await stat(target, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    expect(await readdir(root)).toEqual(["cover.webp"]);
    await expect(stat(path.join(root, ".mep-mirror"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(logs).toEqual([]);
  });
  it("round-trips user files and directories containing .local-", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const client = await syncedClient(cookbook);
    const userFiles = new Map([
      ["family.local-notes.md", "family notes\n"],
      ["notes.local-20260910-123456.md", "timestamp-shaped user note\n"],
      [".notes.local-mirror-999-1.md", "temp-shaped user note\n"],
      ["archive.local-20260910-123456/inside.md", "inside user directory\n"],
    ]);
    for (const [relative, text] of userFiles) {
      const target = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const temporary = path.join(root, ".mep-mirror/stale.md");
    await mkdir(path.dirname(temporary));
    await writeFile(temporary, "generated temporary bytes\n");
    await mirrorOnce(root, cookbook);
    await waitFor(() => {
      for (const [relative, text] of userFiles) expect(readCookbookText(client.doc, relative)).toBe(text);
    });
    expect(readCookbookText(client.doc, ".mep-mirror/stale.md")).toBeNull();
    writeCookbookText(client.doc, "remote.local-20260910-123456.md", "remote user note\n");
    const verifier = await syncedClient(cookbook);
    expect(readCookbookText(verifier.doc, "remote.local-20260910-123456.md")).toBe("remote user note\n");
    await mirrorOnce(root, cookbook);
    await expect(readFile(path.join(root, "remote.local-20260910-123456.md"), "utf8")).resolves.toBe("remote user note\n");
    startMirror(root, cookbook);
    const watched = path.join(root, "live.local-20260910-123456/watched.md");
    await mkdir(path.dirname(watched));
    await writeFile(watched, "watched user directory\n");
    await waitFor(() => expect(readCookbookText(client.doc, "live.local-20260910-123456/watched.md")).toBe("watched user directory\n"));
  });
  it("keeps final recovery private while retaining the displaced mode", async () => {
    const { root, target, cookbook, client } = await binaryConflict("cover.webp", "local image", "shared image");
    const privateRoot = path.join(root, ".mep-mirror");
    await mkdir(privateRoot, { mode: 0o777 });
    await chmod(privateRoot, 0o777);
    await chmod(target, 0o640);
    const logs: string[] = [];
    const previous = process.umask(0);
    try { await mirrorOnce(root, cookbook, { now: fixedNow, log: (line) => logs.push(line) }); }
    finally { process.umask(previous); }
    const recovery = await recoveryWith(root, "local image");
    const relative = path.relative(root, recovery).split(path.sep).join("/");
    expect(relative).toMatch(/^\.mep-mirror\/[^/]+\/cover\.local-20260910-123456\.webp$/);
    expect(logs).toEqual([`wrote cover.webp; preserved local copy as ${relative}\n`]);
    await expect(readFile(target, "utf8")).resolves.toBe("shared image");
    expect(readCookbookBytes(client.doc, relative)).toBeNull();
    expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(path.dirname(recovery))).mode & 0o777).toBe(0o700);
    await waitFor(async () => expect(readdir(path.dirname(recovery))).resolves.toEqual([path.basename(recovery)]));
    expect((await stat(recovery)).mode & 0o777).toBe(0o640);
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(recovery + logs.join("")).not.toContain(cookbook);
  });
  it("places nested recovery in one final same-parent private namespace", async () => {
    const relative = "images/nested/cover.webp";
    const { root, target, cookbook } = await binaryConflict(relative, "new local bytes", "shared bytes");
    await mirrorOnce(root, cookbook, { now: fixedNow });
    const recovery = await recoveryWith(root, "new local bytes");
    expect(path.relative(root, recovery).split(path.sep).join("/")).toMatch(/^images\/nested\/\.mep-mirror\/[^/]+\/cover\.local-20260910-123456\.webp$/);
    await expect(readFile(target, "utf8")).resolves.toBe("shared bytes");
  });
  it("refuses unavailable or symlinked same-parent recovery without changing the mirror", async () => {
    for (const kind of ["blocked", "symlink", "nested-symlink"] as const) {
      const relative = kind === "nested-symlink" ? "images/nested/cover.webp" : "cover.webp";
      const { root, target, cookbook } = await binaryConflict(relative);
      const outside = kind === "blocked" ? null : await folder();
      const privateRoot = path.join(path.dirname(target), ".mep-mirror");
      if (outside) await symlink(outside, privateRoot);
      else await writeFile(privateRoot, "blocking file");
      await expect(mirrorOnce(root, cookbook)).rejects.toThrow("refusing invalid mirror recovery directory");
      if (outside) expect(await readdir(outside)).toEqual([]);
      await expect(readFile(target, "utf8")).resolves.toBe("local bytes");
    }
  });

  it("restores a mismatched regular capture without clobber", async () => {
    const root = await folder();
    const target = path.join(root, "cover.webp");
    await writeFile(target, "changed writer bytes");
    await chmod(target, 0o640);
    const mismatch = await atomicCommit(target, encoder.encode("stale bytes"), encoder.encode("remote bytes"), currentCommit);
    expect(mismatch.result).toBe("retry");
    await expect(readFile(target, "utf8")).resolves.toBe("changed writer bytes");
    await expect(readFile(mismatch.recovery!, "utf8")).resolves.toBe("changed writer bytes");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });
  it("rereads and converges through the live caller after publication EEXIST", async () => {
    const root = await folder();
    const target = path.join(root, "cover.webp");
    const local = Uint8Array.from([0x80, 0x01]);
    const remote = Uint8Array.from([0xff, 0x02]);
    const { cookbook } = await remoteFile("cover.webp", remote);
    const logs: string[] = [];
    let planted = false;
    const watcher = watchDirectory(root, { recursive: true }, () => {
      if (planted) return;
      try { writeFileSync(target, local, { flag: "wx" }); planted = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    });
    try { await mirrorOnce(root, cookbook, { now: fixedNow, log: (line) => logs.push(line) }); }
    finally { watcher.close(); }
    expect(planted).toBe(true);
    expect(new Uint8Array(await readFile(target))).toEqual(remote);
    const recovery = await recoveryWith(root, local);
    expect(logs).toContain(`wrote cover.webp; preserved local copy as ${path.relative(root, recovery).split(path.sep).join("/")}
`);
  });
  it("reports a post-rename non-regular path at its final recovery name", async () => {
    const root = await folder();
    const target = path.join(root, "cover.webp");
    await mkdir(target);
    await writeFile(path.join(target, "inside"), "directory writer bytes");
    await expect(atomicCommit(target, Uint8Array.of(1), Uint8Array.of(2), currentCommit))
      .rejects.toThrow(/non-regular path after the atomic move.*captured path kept at .*\.mep-mirror/);
    const recovered = await recoveryWith(root, "directory writer bytes");
    expect(recovered).toContain("cover.local-20260910-123456.webp");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("merges unknown initial text as peer content instead of overwriting it", async () => {
    const root = await folder();
    await writeFile(path.join(root, "notes.md"), "local starting point\n");
    const { cookbook, client } = await remoteFile("notes.md", "cookbook starting point\n");
    const logs: string[] = [];
    await mirrorOnce(root, cookbook, { log: (line) => logs.push(line) });
    const merged = "local starting point\ncookbook starting point\n";
    await expect(readFile(path.join(root, "notes.md"), "utf8")).resolves.toBe(merged);
    await waitFor(() => expect(readCookbookText(client.doc, "notes.md")).toBe(merged));
    expect(logs.some((line) => line.startsWith("merged local changes with cookbook for notes.md"))).toBe(true);
  });
  it("writes both sides of an overlapping text edit with conflict markers", () => {
    const [baseline, local, remote] = ["first: base\nsecond: base\n", "first: disk\nsecond: base\n", "first: cookbook\nsecond: base\n"].map((text) => encoder.encode(text));
    const plan = diskPlan("notes.md", "conflict", true, baseline, local, remote);
    expect(plan.merged).toBe("<<<<<<< this device\nfirst: disk\n=======\nfirst: cookbook\n>>>>>>>>\nsecond: base\n");
    expect(plan.desired).toEqual(encoder.encode(plan.merged!));
    expect(plan.message).toBe("merged local changes with cookbook for notes.md; kept 1 conflict");
  });
  it("lets a Y.Doc delete win while retaining a late local inode write", async () => {
    const logs: string[] = [];
    const { root, target, client } = await startedMirrorFile("Shopping.md", "shared\n", { now: fixedNow, log: (line) => logs.push(line) });
    const descriptor = await open(target, "r+");
    try {
      deleteCookbookPath(client.doc, "Shopping.md");
      await waitFor(async () => expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" }));
      await descriptor.truncate(0);
      await descriptor.writeFile("late local change\n");
    } finally { await descriptor.close(); }
    const recovery = await recoveryWith(root, "late local change\n");
    const relative = path.relative(root, recovery).split(path.sep).join("/");
    expect(logs).toContain(`deleted Shopping.md; preserved local copy as ${relative}\n`);
  });
  it("preserves a non-UTF8 local binary file when the cookbook holds different bytes", async () => {
    const local = Uint8Array.from([0x80, 0x00, 0x02]);
    const remote = Uint8Array.from([0xfe, 0x00, 0x03]);
    const root = await folder();
    const target = path.join(root, "cover.webp");
    await writeFile(target, local);
    const { cookbook } = await remoteFile("cover.webp", remote);
    await mirrorOnce(root, cookbook, { now: fixedNow });
    expect(new Uint8Array(await readFile(target))).toEqual(remote);
    await recoveryWith(root, local);
  });
  it("merges divergent files when two continuous mirrors start together", async () => {
    const left = await folder();
    const right = await folder();
    await writeFile(path.join(left, "same.md"), "left addition\n");
    await writeFile(path.join(right, "same.md"), "right addition\n");
    const cookbook = newCookbookId();
    const client = await syncedClient(cookbook);
    startMirror(left, cookbook);
    startMirror(right, cookbook);
    await waitFor(() => {
      const text = readCookbookText(client.doc, "same.md") ?? "";
      expect(text).toContain("left addition");
      expect(text).toContain("right addition");
    });
    await waitFor(async () => {
      const shared = readCookbookText(client.doc, "same.md");
      expect(await readFile(path.join(left, "same.md"), "utf8")).toBe(shared);
      expect(await readFile(path.join(right, "same.md"), "utf8")).toBe(shared);
    });
  }, 12_000);

  it("does not create an unhandled rejection with a pending disk event after fatal", async () => {
    const seen: unknown[] = [];
    const failure = new Error("fatal injection");
    let observed: unknown;
    let acknowledge!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { acknowledge = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = createPathScheduler(async (paths) => {
      expect(paths).toContain("active-disk-event");
      acknowledge();
      await gate;
      throw failure;
    }, (error) => { observed = error; });
    const onUnhandled = (reason: unknown) => { seen.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      scheduler.schedule("active-disk-event");
      await started;
      scheduler.schedule("pending-disk-event");
      release();
      await scheduler.close();
      scheduler.schedule("after-fatal");
      await new Promise((resolve) => setImmediate(resolve));
      expect(observed).toBe(failure);
      expect(seen).toEqual([]);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });
  it("drains accepted scheduler work serially during graceful close", async () => {
    const calls: string[][] = [];
    let acknowledge!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { acknowledge = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = createPathScheduler(async (paths) => {
      calls.push([...paths]);
      if (calls.length === 1) { acknowledge(); await gate; }
    }, (error) => { throw error; });
    scheduler.schedule("active");
    await started;
    scheduler.schedule("pending");
    const closing = scheduler.close();
    scheduler.schedule("rejected-after-close");
    release();
    await closing;
    expect(calls).toEqual([["active"], ["pending"]]);
  });

  it("starts a new drain for work accepted at the tail microtask boundary", async () => {
    const calls: string[][] = [];
    let scheduler!: ReturnType<typeof createPathScheduler>;
    let acknowledge!: () => void;
    const lateRan = new Promise<void>((resolve) => { acknowledge = resolve; });
    scheduler = createPathScheduler(async (paths) => {
      calls.push([...paths]);
      if (paths.includes("first")) {
        void Promise.resolve().then(() => undefined).then(() => scheduler.schedule("late"));
      } else acknowledge();
    }, (error) => { throw error; });
    scheduler.schedule("first");
    await lateRan;
    await scheduler.close();
    expect(calls).toEqual([["first"], ["late"]]);
  });

  it("stops accepting remote work before continuous-mirror teardown drains", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const client = await syncedClient(cookbook);
    const controller = new AbortController();
    const running = mirrorCookbook({ folder: root, cookbook, relay, signal: controller.signal });
    writeCookbookText(client.doc, "ready.md", "ready\n");
    await waitFor(async () => expect(readFile(path.join(root, "ready.md"), "utf8")).resolves.toBe("ready\n"));
    controller.abort();
    writeCookbookText(client.doc, "during-close.md", "ignored\n");
    await running;
    writeCookbookText(client.doc, "after-close.md", "ignored\n");
    await new Promise((resolve) => setImmediate(resolve));
    for (const file of ["during-close.md", "after-close.md"]) {
      await expect(readFile(path.join(root, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
