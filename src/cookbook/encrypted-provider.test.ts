import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { cookbookCipher, newEnvelopeId, type CookbookCipher } from "./crypto";
import { EncryptedCookbookBridge, SEALED_RECORDS } from "./encrypted-provider";
import { newCookbookId, readCookbookText, writeCookbookText } from "./doc";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));

async function peer(secret: string, wrap: (cipher: CookbookCipher) => CookbookCipher = (cipher) => cipher) {
  const doc = new Y.Doc();
  const wire = new Y.Doc();
  const failure = vi.fn();
  const bridge = new EncryptedCookbookBridge(doc, wire, wrap(await cookbookCipher(secret)), failure);
  cleanup.push(() => { bridge.destroy(); wire.destroy(); doc.destroy(); });
  return { doc, wire, bridge, failure };
}

async function exchange(left: Awaited<ReturnType<typeof peer>>, right: Awaited<ReturnType<typeof peer>>) {
  await Promise.all([left.bridge.settled(), right.bridge.settled()]);
  const l = Y.encodeStateAsUpdate(left.wire);
  const r = Y.encodeStateAsUpdate(right.wire);
  Y.applyUpdate(left.wire, r);
  Y.applyUpdate(right.wire, l);
  await Promise.all([left.bridge.settled(), right.bridge.settled()]);
}

describe("encrypted Yjs projection", () => {
  it("keeps recipe names and text out of the wire document and preserves offline concurrent edits through compaction", async () => {
    const secret = newCookbookId();
    const left = await peer(secret);
    const right = await peer(secret);
    writeCookbookText(left.doc, "PrivateRecipe.md", "private onions\nprivate milk\n");
    await exchange(left, right);
    expect(readCookbookText(right.doc, "PrivateRecipe.md")).toBe("private onions\nprivate milk\n");
    const wireBytes = Y.encodeStateAsUpdate(left.wire);
    expect(new TextDecoder().decode(wireBytes)).not.toMatch(/PrivateRecipe|private onions|private milk/);
    expect([...left.wire.share.keys()]).toEqual([SEALED_RECORDS]);
    expect(left.wire.getMap(SEALED_RECORDS).size).toBeGreaterThan(0);

    writeCookbookText(left.doc, "PrivateRecipe.md", "bought onions\nprivate milk\n");
    writeCookbookText(right.doc, "PrivateRecipe.md", "private onions\nbought milk\n");
    // Each side compacts while unaware of the other's edit and snapshot.
    await Promise.all([left.bridge.sync(), right.bridge.sync()]);
    await exchange(left, right);
    expect(readCookbookText(left.doc, "PrivateRecipe.md")).toBe("bought onions\nbought milk\n");
    expect(readCookbookText(right.doc, "PrivateRecipe.md")).toBe("bought onions\nbought milk\n");
    await left.bridge.sync();
    await exchange(left, right);
    expect(left.bridge.records.size).toBe(1);

    // A device with no plaintext history reconstructs the complete cookbook from the compacted wire state.
    const fresh = await peer(secret);
    Y.applyUpdate(fresh.wire, Y.encodeStateAsUpdate(left.wire));
    await fresh.bridge.settled();
    expect(readCookbookText(fresh.doc, "PrivateRecipe.md")).toBe("bought onions\nbought milk\n");
    expect(left.failure).not.toHaveBeenCalled();
    expect(right.failure).not.toHaveBeenCalled();
  });

  it("keeps updates that arrive while snapshot encryption is in flight", async () => {
    const secret = newCookbookId();
    let hold = false;
    let announce!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const left = await peer(secret, (cipher) => ({ ...cipher, async seal(id, update) {
      if (hold) { announce(); await gate; }
      return cipher.seal(id, update);
    } }));
    const right = await peer(secret);
    writeCookbookText(left.doc, "base.md", "base");
    await exchange(left, right);
    hold = true;
    const compacting = left.bridge.sync();
    await entered;
    writeCookbookText(right.doc, "late.md", "concurrent late edit");
    await right.bridge.settled();
    Y.applyUpdate(left.wire, Y.encodeStateAsUpdate(right.wire));
    release();
    await compacting;
    await exchange(left, right);
    const fresh = await peer(secret);
    Y.applyUpdate(fresh.wire, Y.encodeStateAsUpdate(left.wire));
    await fresh.bridge.settled();
    expect(readCookbookText(fresh.doc, "late.md")).toBe("concurrent late edit");
  });

  it("bounds the active record set during sustained edits and authenticates before applying a batch", async () => {
    const secret = newCookbookId();
    const left = await peer(secret);
    for (let n = 0; n < 130; n++) writeCookbookText(left.doc, "private.md", `private ${n}`);
    await left.bridge.settled();
    expect(left.bridge.records.size).toBeLessThan(64);
    const fresh = await peer(secret);
    const id = newEnvelopeId();
    left.bridge.records.set(id, new Uint8Array([1, 2, 3]));
    Y.applyUpdate(fresh.wire, Y.encodeStateAsUpdate(left.wire));
    await expect(fresh.bridge.settled()).rejects.toThrow("Invalid encrypted");
    expect(fresh.failure).toHaveBeenCalledOnce();
    expect(readCookbookText(fresh.doc, "private.md")).toBeNull();
  });
});
