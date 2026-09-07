import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cookbookIdFromUrl, isCookbookId } from "../src/cookbook/doc";

export const DEFAULT_RELAY_URL = "wss://enplace-relay.joesdownloads.workers.dev/parties/kitchen";
export type CookbookAssociation = { id: string; relayUrl: string };
export const associationPath = (): string => path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "enplace", "cookbook.json");

export function validateRelayUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid relay address."); }
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Relay must use secure WebSocket transport, or loopback for local testing.");
  }
  return url.href.replace(/\/$/, "");
}

export function parseAssociation(link: string, relayUrl = DEFAULT_RELAY_URL): CookbookAssociation {
  const input = link.trim();
  let id: string | null = null;
  try { id = isCookbookId(input) ? input : cookbookIdFromUrl(input); } catch { /* Never echo an invalid capability. */ }
  if (!id) throw new Error("Invalid cookbook link.");
  return { id, relayUrl: validateRelayUrl(relayUrl) };
}

export async function readAssociation(file = associationPath()): Promise<CookbookAssociation> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()) || info.size > 4096) {
      throw new Error("Cookbook association must be an owner-only regular file.");
    }
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || !("id" in value) || !("relayUrl" in value) ||
      typeof value.id !== "string" || typeof value.relayUrl !== "string") throw new Error();
    return parseAssociation(value.id, value.relayUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Connect a cookbook first with mep cookbook use (paste its link at the hidden prompt).");
    throw new Error("Cannot read the private cookbook association. Check its format, ownership and 0600 permissions.");
  } finally { await handle?.close(); }
}

export async function saveAssociation(value: CookbookAssociation, file = associationPath()): Promise<void> {
  const checked = parseAssociation(value.id, value.relayUrl);
  const parent = path.dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) {
    throw new Error("Use a dedicated owner-only directory (0700) for the cookbook association.");
  }
  const temporary = path.join(parent, `.cookbook-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(checked) + "\n");
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

/** A capability is read from stdin, never a positional argument or echoed terminal input. */
export async function readCookbookLink(): Promise<string> {
  if (!process.stdin.isTTY) {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 4096) throw new Error("Cookbook link is too long.");
    }
    return text;
  }
  process.stderr.write("Cookbook link (hidden): ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") { finish(new Error("Cookbook connection cancelled.")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
        if (value.length > 4096) { finish(new Error("Cookbook link is too long.")); return; }
      }
    };
    process.stdin.on("data", onData);
  });
}
