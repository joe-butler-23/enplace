const encoder = new TextEncoder();
const CONTEXT = "enplace/cookbook/v1";
const SECRET = /^e1_[a-z2-7]{52}$/;
const ENVELOPE = /^[a-f0-9]{32}$/;
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

export function isEncryptedCookbookId(id: string): boolean { return SECRET.test(id); }

export type CookbookCipher = {
  room: string;
  seal: (id: string, update: Uint8Array) => Promise<Uint8Array>;
  open: (id: string, sealed: Uint8Array) => Promise<Uint8Array>;
};

/** The fragment secret never becomes a room name or a network credential. */
export async function cookbookCipher(secret: string): Promise<CookbookCipher> {
  if (!isEncryptedCookbookId(secret)) throw new Error("This cookbook needs a new encrypted sharing link.");
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey", "deriveBits"]);
  const parameters = { name: "HKDF", hash: "SHA-256", salt: encoder.encode(CONTEXT) };
  const key = await crypto.subtle.deriveKey({ ...parameters, info: encoder.encode("content") }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const roomBytes = new Uint8Array(await crypto.subtle.deriveBits({ ...parameters, info: encoder.encode("room") }, material, 256));
  const room = `e1-${Array.from(roomBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const aad = (id: string): Uint8Array => {
    if (!ENVELOPE.test(id)) throw new Error("Invalid encrypted cookbook record.");
    return encoder.encode(`${CONTEXT}/${room}/${id}`);
  };
  return {
    room,
    async seal(id, update) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: buffer(aad(id)), tagLength: 128 }, key, buffer(update)));
      const sealed = new Uint8Array(1 + iv.length + encrypted.length);
      sealed[0] = 1;
      sealed.set(iv, 1);
      sealed.set(encrypted, 13);
      return sealed;
    },
    async open(id, sealed) {
      if (!(sealed instanceof Uint8Array) || sealed.length < 29 || sealed[0] !== 1) {
        throw new Error("Invalid encrypted cookbook record.");
      }
      try {
        return new Uint8Array(await crypto.subtle.decrypt({
          name: "AES-GCM", iv: buffer(sealed.subarray(1, 13)), additionalData: buffer(aad(id)), tagLength: 128,
        }, key, buffer(sealed.subarray(13))));
      } catch {
        throw new Error("Cookbook authentication failed. The shared data or link is invalid.");
      }
    },
  };
}

export function newEnvelopeId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
