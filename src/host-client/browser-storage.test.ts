import { afterEach, describe, expect, it, vi } from "vitest";
import { openKitchen, type KitchenConnection } from "./kitchen-storage";
import { readKitchenText, writeKitchenText } from "../kitchen/doc";
import { setCurrentKitchenConnection } from "../kitchen/current";
import {
  readText,
  updateText,
} from "./browser-storage";

const connections: KitchenConnection[] = [];

async function selectKitchen(initial: Record<string, string> = {}): Promise<KitchenConnection> {
  const connection = await openKitchen({
    id: `abcdefghijklmnopqrstuvwxyz${connections.length}`,
    relayUrl: null,
    persist: false,
  });
  connection.doc.transact(() => {
    for (const [path, text] of Object.entries(initial)) writeKitchenText(connection.doc, path, text);
  });
  connections.push(connection);
  setCurrentKitchenConnection(connection);
  return connection;
}

afterEach(async () => {
  setCurrentKitchenConnection(null);
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

describe("vault storage adapter contract", () => {
  it("fails clearly when no kitchen connection is active", async () => {
    setCurrentKitchenConnection(null);
    await expect(readText("Plan.md")).rejects.toThrow("No kitchen connection is active");
    expect(() => updateText("Plan.md", (text) => text)).toThrow("No kitchen connection is active");
  });

  it("delegates live text helpers to the current kitchen adapter", async () => {
    const connection = await selectKitchen({ "a.md": "one" });
    expect(await readText("a.md")).toBe("one");
    expect(readKitchenText(connection.doc, "a.md")).toBe("one");
  });

  it("delegates live text updates and does not write an unchanged result", async () => {
    const connection = await selectKitchen({ "Shopping.md": "milk\n" });
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
