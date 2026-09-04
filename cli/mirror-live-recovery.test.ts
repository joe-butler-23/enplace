import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, closeSync, existsSync, ftruncateSync, openSync, unlinkSync, watch as watchDirectory, writeSync } from "node:fs";
import { chmod, link, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { newCookbookId, readCookbookBytes, writeCookbookBytes } from "../src/cookbook/doc";
import { createPrivateOperation, unlinkIfPresent } from "./mirror-commit";
import { cleanupReplacementScratch, mirrorCookbook } from "./mirror";
import { MirrorTestFixture, waitFor } from "./mirror-test-support";

const harness = new MirrorTestFixture();
let relay: string;
const folder = (): Promise<string> => harness.folder();
const client = async (cookbook: string) => (await harness.client(cookbook)).doc;

async function onlyRecovery(root: string): Promise<string> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (/\.local-\d{8}-\d{6}/.test(entry.name)) found.push(child);
    }
  };
  await visit(root);
  expect(found).toHaveLength(1);
  return found[0];
}
beforeAll(async () => { await harness.start(); relay = harness.relay; });
afterEach(async () => harness.cleanup());
afterAll(async () => harness.close());

describe("mirror recovery lifecycle", () => {
  it("allocates concurrent production operations exclusively without touching a planted leaf", async () => {
    const root = await folder();
    const planted = path.join(root, ".mep-mirror", "operation-planted");
    await mkdir(planted, { recursive: true, mode: 0o700 });
    const sentinel = path.join(planted, "sentinel.local-20260910-123456");
    await writeFile(sentinel, "sentinel");
    const [first, second] = await Promise.all([createPrivateOperation(root), createPrivateOperation(root)]);
    expect(path.basename(first)).toMatch(/^operation-/);
    expect(path.basename(second)).toMatch(/^operation-/);
    expect(first).not.toBe(second);
    expect([first, second]).not.toContain(planted);
    await expect(readFile(sentinel, "utf8")).resolves.toBe("sentinel");
  });

  it("keeps absent or unequal staging harmless and removes only an empty operation", async () => {
    const root = await folder();
    const privateRoot = path.join(root, ".mep-mirror");
    const retained = path.join(privateRoot, "operation-retained");
    const unequal = path.join(privateRoot, "operation-unequal");
    const empty = path.join(privateRoot, "operation-empty");
    const unrelated = path.join(privateRoot, "unrelated-empty");
    await mkdir(retained, { recursive: true, mode: 0o700 });
    await mkdir(unequal, { mode: 0o700 });
    await mkdir(empty, { mode: 0o700 });
    await mkdir(unrelated, { mode: 0o700 });
    const recovery = "cover.local-20260910-123456.webp";
    await writeFile(path.join(retained, recovery), "local retained");
    await writeFile(path.join(unequal, recovery), "local unequal");
    await writeFile(path.join(unequal, "replacement"), "staged remote");
    await writeFile(path.join(root, "cover.webp"), "different public");
    await expect(unlinkIfPresent(path.join(root, "missing"))).resolves.toBeUndefined();
    await cleanupReplacementScratch(root);
    await expect(readFile(path.join(retained, recovery), "utf8")).resolves.toBe("local retained");
    await expect(readFile(path.join(unequal, recovery), "utf8")).resolves.toBe("local unequal");
    await expect(readFile(path.join(unequal, "replacement"), "utf8")).resolves.toBe("staged remote");
    expect(existsSync(empty)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it.each(["unlink", "rmdir"])("propagates an unexpected %s cleanup failure", async (operation) => {
    const root = await folder();
    const privateRoot = path.join(root, ".mep-mirror");
    const leaf = path.join(privateRoot, "operation-blocked");
    await mkdir(leaf, { recursive: true, mode: 0o700 });
    if (operation === "unlink") {
      const replacement = path.join(leaf, "replacement");
      await writeFile(replacement, "staged");
      await chmod(leaf, 0o500);
      try { await expect(unlinkIfPresent(replacement)).rejects.toMatchObject({ code: "EACCES" }); }
      finally { chmodSync(leaf, 0o700); }
    } else {
      await chmod(privateRoot, 0o500);
      try { await expect(cleanupReplacementScratch(root)).rejects.toMatchObject({ code: "EACCES" }); }
      finally { chmodSync(privateRoot, 0o700); }
    }
  });

  it("reports a retained recovery when a real retry becomes a local early exit", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const doc = await client(cookbook);
    const target = path.join(root, "cover.webp");
    const baseline = Uint8Array.from([0x01, 0x02, 0x03]);
    const logs: string[] = [];
    writeCookbookBytes(doc, "cover.webp", baseline);
    const controller = new AbortController();
    const running = mirrorCookbook({ folder: root, cookbook, relay, signal: controller.signal, log: (line) => logs.push(line) });
    await waitFor(async () => expect(new Uint8Array(await readFile(target))).toEqual(baseline));
    const descriptor = openSync(target, "r+");
    let injected = false;
    const watcher = watchDirectory(root, { recursive: true }, (_event, filename) => {
      if (injected || !filename?.toString().includes(".mep-mirror/operation-")) return;
      injected = true;
      const local = Buffer.alloc(16 * 1024 * 1024, 0x7a);
      ftruncateSync(descriptor, 0);
      writeSync(descriptor, local, 0, local.length, 0);
      writeCookbookBytes(doc, "cover.webp", baseline);
    });
    try {
      writeCookbookBytes(doc, "cover.webp", Uint8Array.from([0x09, 0x08, 0x07]));
      await waitFor(() => expect(logs.some((line) => line.startsWith("retained local recovery; preserved local copy as "))).toBe(true));
      const recovery = await onlyRecovery(root);
      const relative = path.relative(root, recovery).split(path.sep).join("/");
      expect(logs).toContain(`retained local recovery; preserved local copy as ${relative}\n`);
      expect((await stat(recovery)).size).toBe(16 * 1024 * 1024);
    } finally {
      watcher.close();
      closeSync(descriptor);
      controller.abort();
      await running;
    }
  });

  it("restores a live local deletion that conflicts with a remote update", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const doc = await client(cookbook);
    const target = path.join(root, "notes.md");
    const logs: string[] = [];
    writeCookbookBytes(doc, "notes.md", Buffer.from("baseline\n"));
    const controller = new AbortController();
    const running = mirrorCookbook({ folder: root, cookbook, relay, signal: controller.signal, log: (line) => logs.push(line) });
    await waitFor(async () => expect(readFile(target, "utf8")).resolves.toBe("baseline\n"));
    let deleted = false;
    const watcher = watchDirectory(root, { recursive: true }, (_event, filename) => {
      if (deleted || !filename?.toString().includes(".mep-mirror/operation-")) return;
      try { unlinkSync(target); deleted = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
    writeCookbookBytes(doc, "notes.md", Buffer.from("remote update\n"));
    await waitFor(async () => expect(readFile(target, "utf8")).resolves.toBe("remote update\n"));
    watcher.close();
    controller.abort();
    await running;
    expect(deleted).toBe(true);
    expect(logs).toContain("restored notes.md; local deletion conflicted with cookbook change\n");
  });

  it("imports an initially local-only non-UTF8 binary through --once semantics", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const doc = await client(cookbook);
    const bytes = Uint8Array.from([0x00, 0xff, 0x80, 0x41]);
    await writeFile(path.join(root, "cover.webp"), bytes);
    await mirrorCookbook({ folder: root, cookbook, relay, once: true });
    await waitFor(() => expect(readCookbookBytes(doc, "cover.webp")).toEqual(bytes));
  });

  it("recovers open-descriptor and hard-linked alias bytes across SIGKILL and restart", async () => {
    const root = await folder();
    const cookbook = newCookbookId();
    const doc = await client(cookbook);
    const target = path.join(root, "cover.webp");
    const original = Buffer.alloc(64 * 1024 * 1024, 0x5a);
    const remote = Uint8Array.from([0xde, 0xad, 0x00, 0xbe]);
    const late = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    await writeFile(target, original);
    await chmod(target, 0o640);
    const alias = path.join(await folder(), "alias.webp");
    await link(target, alias);
    writeCookbookBytes(doc, "cover.webp", remote);
    const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "cli/vitest.process.config.ts"], {
      cwd: process.cwd(), detached: true, env: { ...process.env, MEP_PROCESS_LOSS_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    try {
      await waitFor(() => expect(stdout).toMatch(/MEP_RECOVERY_ACK:/));
      process.kill(-child.pid!, "SIGKILL");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })));
      expect(exit).toEqual({ code: null, signal: "SIGKILL" });
      const recovery = await onlyRecovery(root);
      expect(path.basename(recovery)).toBe("cover.local-20260910-123456.webp");
      expect(Buffer.from(await readFile(recovery)).equals(late)).toBe(true);
      expect((await stat(recovery)).mode & 0o777).toBe(0o640);
      expect(Buffer.from(await readFile(alias)).equals(late)).toBe(true);
      expect((await stat(alias)).mode & 0o777).toBe(0o640);
      expect(recovery).not.toContain(cookbook);
      expect(await readdir(path.dirname(recovery))).toContain("replacement");
      await mirrorCookbook({ folder: root, cookbook, relay, once: true });
      expect(new Uint8Array(await readFile(target))).toEqual(remote);
      expect(Buffer.from(await readFile(recovery)).equals(late)).toBe(true);
      expect(Buffer.from(await readFile(alias)).equals(late)).toBe(true);
      expect(await readdir(path.dirname(recovery))).toEqual([path.basename(recovery)]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
      if (stderr) process.stderr.write(stderr);
    }
  }, 30_000);
});
