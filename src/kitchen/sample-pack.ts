import type * as Y from "yjs";
import samplePackUrl from "../../sample/sample-pack.pack?url&no-inline";
import { writeKitchenBytes } from "./doc";

const decoder = new TextDecoder();
type PackedEntry = readonly [path: string, length: number];

function unpackSample(bytes: Uint8Array): Array<readonly [string, Uint8Array]> {
  if (decoder.decode(bytes.subarray(0, 4)) !== "MEP1") throw new Error("Invalid sample pack.");
  const manifestLength = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
  const dataOffset = 8 + manifestLength;
  const manifest = JSON.parse(decoder.decode(bytes.subarray(8, dataOffset))) as PackedEntry[];
  let offset = dataOffset;
  return manifest.map(([path, length]) => {
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return [path, value] as const;
  });
}

/** Every file installed by seedSamplePack. Covers are URLs under public/samples, not kitchen files. */
export const SAMPLE_PATHS = [
  "banana-oat-loaf.md",
  "beef-pepper-noodles.md",
  "chicken-mushroom-risotto.md",
  "chickpea-coconut-curry.md",
  "lemon-chicken-traybake.md",
  "mustard-salmon-potatoes.md",
  "roast-vegetable-couscous-salad.md",
  "sausage-apple-bake.md",
  "smoky-lentil-soup.md",
  "spinach-feta-omelette.md",
  "white-bean-tomato-stew.md",
] as const;

export async function seedSamplePack(doc: Y.Doc): Promise<void> {
  const response = await fetch(samplePackUrl);
  if (!response.ok) throw new Error("Could not load the sample kitchen.");
  const entries = unpackSample(new Uint8Array(await response.arrayBuffer()));
  doc.transact(() => {
    for (const [path, bytes] of entries) writeKitchenBytes(doc, path, bytes);
  });
}
