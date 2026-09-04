import type * as Y from "yjs";
import samplePackUrl from "../../sample/sample-pack.pack?url&no-inline";
import sampleCoversUrl from "../../sample/sample-covers.pack?url&no-inline";
import { listCookbookPaths, writeCookbookBytes } from "./doc";

const decoder = new TextDecoder();
type PackedEntry = readonly [path: string, length: number];
type UnpackedEntry = readonly [path: string, bytes: Uint8Array];

function unpackSample(bytes: Uint8Array): UnpackedEntry[] {
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

async function fetchPack(url: string): Promise<UnpackedEntry[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load the sample cookbook.");
  return unpackSample(new Uint8Array(await response.arrayBuffer()));
}

export const SAMPLE_RECIPE_PATHS = [
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

const stemOf = (recipePath: string): string => recipePath.replace(/\.md$/, "");

/** What the grid needs to paint: every recipe and its card thumbnail. */
export const SAMPLE_SEED_PATHS = SAMPLE_RECIPE_PATHS.flatMap((recipePath) =>
  [recipePath, `images/${stemOf(recipePath)}.card.webp`]);

/** Full-size covers, which only the recipe page shows. */
export const SAMPLE_COVER_PATHS = SAMPLE_RECIPE_PATHS.map((recipePath) =>
  `images/${stemOf(recipePath)}.webp`);

/** Every path the two sample packs install between them. */
export const SAMPLE_PATHS = [...SAMPLE_SEED_PATHS, ...SAMPLE_COVER_PATHS];

/** Blocking half of the seed: recipes and card thumbnails, written in one transaction. */
export async function seedSamplePack(doc: Y.Doc): Promise<void> {
  const entries = await fetchPack(samplePackUrl);
  doc.transact(() => {
    for (const [path, bytes] of entries) writeCookbookBytes(doc, path, bytes);
  });
}

/**
 * The other half, fetched after mount so no first paint waits on it. A cover is written
 * only while its recipe is still present, so samples removed mid-fetch stay removed.
 */
export async function seedSampleCovers(doc: Y.Doc): Promise<void> {
  const entries = await fetchPack(sampleCoversUrl);
  const present = new Set(listCookbookPaths(doc));
  const wanted = entries.filter(([path]) =>
    present.has(`${path.replace(/^images\//, "").replace(/\.webp$/, "")}.md`));
  if (!wanted.length) return;
  doc.transact(() => {
    for (const [path, bytes] of wanted) writeCookbookBytes(doc, path, bytes);
  });
}
