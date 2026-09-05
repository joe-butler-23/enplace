import { describe, expect, it } from "vitest";
import { cookbookCipher, newEnvelopeId } from "./crypto";
import { newCookbookId } from "./doc";

describe("cookbook encryption", () => {
  it("derives a public room separately from the link secret and encrypts with unique nonces", async () => {
    const secret = newCookbookId();
    const left = await cookbookCipher(secret);
    const right = await cookbookCipher(secret);
    expect(left.room).toBe(right.room);
    expect(left.room).not.toContain(secret);
    const id = newEnvelopeId();
    const plaintext = new TextEncoder().encode("private recipe title / 2 secret onions");
    const first = await left.seal(id, plaintext);
    const second = await left.seal(id, plaintext);
    expect(first).not.toEqual(second);
    expect(new TextDecoder().decode(first)).not.toContain("private recipe");
    expect(await right.open(id, first)).toEqual(plaintext);
  });

  it("rejects alteration, wrong keys, record substitution, truncation and plaintext", async () => {
    const cipher = await cookbookCipher(newCookbookId());
    const other = await cookbookCipher(newCookbookId());
    const id = newEnvelopeId();
    const plain = new TextEncoder().encode("private recipe title");
    const sealed = await cipher.seal(id, plain);
    const altered = sealed.slice();
    altered[altered.length - 1] ^= 1;
    for (const invalid of [altered, sealed.slice(0, -1), plain]) {
      await expect(cipher.open(id, invalid)).rejects.toThrow();
    }
    await expect(other.open(id, sealed)).rejects.toThrow("authentication failed");
    await expect(cipher.open(newEnvelopeId(), sealed)).rejects.toThrow("authentication failed");
    await expect(cookbookCipher("abcdefghijklmnopqrstuvwxyz")).rejects.toThrow("new encrypted sharing link");
  });
});
