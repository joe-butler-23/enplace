import { newCookbookId } from "../cookbook/doc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCookbook, type CookbookConnection } from "./cookbook-storage";
import { readCookbookText, writeCookbookText } from "../cookbook/doc";
import { setCurrentCookbookConnection } from "../cookbook/current";
import {
  readText,
  updateText,
} from "./browser-storage";

const connections: CookbookConnection[] = [];

async function selectCookbook(initial: Record<string, string> = {}): Promise<CookbookConnection> {
  const connection = await openCookbook({
    id: newCookbookId(),
    relayUrl: null,
    persist: false,
  });
  connection.doc.transact(() => {
    for (const [path, text] of Object.entries(initial)) writeCookbookText(connection.doc, path, text);
  });
  connections.push(connection);
  setCurrentCookbookConnection(connection);
  return connection;
}

afterEach(async () => {
  setCurrentCookbookConnection(null);
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

describe("vault storage adapter contract", () => {
  it("fails clearly when no cookbook connection is active", async () => {
    setCurrentCookbookConnection(null);
    await expect(readText("Plan.md")).rejects.toThrow("No cookbook connection is active");
    expect(() => updateText("Plan.md", (text) => text)).toThrow("No cookbook connection is active");
  });

  it("delegates live text helpers to the current cookbook adapter", async () => {
    const connection = await selectCookbook({ "a.md": "one" });
    expect(await readText("a.md")).toBe("one");
    expect(readCookbookText(connection.doc, "a.md")).toBe("one");
  });

  it("delegates live text updates and does not write an unchanged result", async () => {
    const connection = await selectCookbook({ "Shopping.md": "milk\n" });
    const update = vi.spyOn(connection.adapter, "updateText");
    const documentUpdates = vi.fn();
    connection.doc.on("update", documentUpdates);
    await expect(updateText("Shopping.md", (current) => `${current}eggs\n`)).resolves.toBe("milk\neggs\n");
    expect(documentUpdates).toHaveBeenCalledOnce();
    await expect(updateText("Shopping.md", (current) => current)).resolves.toBe("milk\neggs\n");
    expect(documentUpdates).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps the public surface limited to live app operations", async () => {
    const contract = await import("./browser-storage");
    expect(contract).not.toHaveProperty("useVaultStorage");
    expect(contract).not.toHaveProperty("openDocument");
    expect(contract).not.toHaveProperty("digestText");
    expect(contract).not.toHaveProperty("stat");
    expect(contract).not.toHaveProperty("mkdir");
  });
});
