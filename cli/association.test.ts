import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { newCookbookId } from "../src/cookbook/doc";
import { parseAssociation, readAssociation, saveAssociation, validateRelayUrl } from "./association";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "enplace-association-")); directories.push(directory);
  return path.join(directory, "private", "cookbook.json");
}

describe("private cookbook association", () => {
  it("writes only the capability configuration with owner-only permissions and no plaintext cookbook", async () => {
    const file = await fixture(), id = newCookbookId();
    await saveAssociation(parseAssociation(`https://enplace-trial.pages.dev/#k=${id}`), file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await readAssociation(file)).toEqual({ id, relayUrl: "wss://enplace-relay.joesdownloads.workers.dev/parties/kitchen" });
    expect(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort()).toEqual(["id", "relayUrl"]);
  });
  it("rejects readable-by-others files and symlinks without echoing capability data", async () => {
    const file = await fixture(), id = newCookbookId();
    await saveAssociation(parseAssociation(id), file);
    await chmod(file, 0o644);
    await expect(readAssociation(file)).rejects.toThrow("0600");
    await chmod(file, 0o600);
    const link = file + ".link"; await symlink(file, link);
    await expect(readAssociation(link)).rejects.toThrow("Cannot read");
    await writeFile(file, JSON.stringify({ id: `BAD-${id}`, relayUrl: "wss://relay.test" }));
    await expect(readAssociation(file)).rejects.toThrow("Cannot read");
    try { await readAssociation(file); } catch (error) { expect(String(error)).not.toContain(id); }
  });
  it("rejects plaintext remote transport and credentials or capability fragments in relay URLs", () => {
    for (const url of ["ws://remote.test", "https://relay.test", "wss://user:password@relay.test", "wss://relay.test/#secret", "wss://relay.test/?key=secret"]) {
      expect(() => validateRelayUrl(url)).toThrow();
    }
    expect(validateRelayUrl("ws://127.0.0.1:1234")).toBe("ws://127.0.0.1:1234");
  });
  it("does not change permissions of a caller-selected shared parent directory", async () => {
    const file = await fixture(), parent = path.dirname(file);
    await mkdir(parent, { mode: 0o755 });
    await chmod(parent, 0o755);
    await expect(saveAssociation(parseAssociation(newCookbookId()), file)).rejects.toThrow("dedicated owner-only");
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
