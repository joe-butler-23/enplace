import type * as Y from "yjs";
import { writeKitchenBytes } from "./doc";

const sampleAssets = (import.meta as ImportMeta & {
  glob: (pattern: string, options: { eager: boolean; query: string; import: string }) => Record<string, string>;
}).glob("../../sample/{recipes,images}/*", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
});

function logicalSamplePath(sourcePath: string): string | null {
  const match = /sample\/(recipes|images)\/([^/]+)$/.exec(sourcePath);
  if (!match) return null;
  return match[1] === "recipes" ? match[2] : `images/${match[2]}`;
}

/** Every file installed by seedSamplePack, including recipe covers. */
export const SAMPLE_PATHS = Object.keys(sampleAssets).map((sourcePath) => {
  const path = logicalSamplePath(sourcePath);
  if (!path) throw new Error(`Unexpected sample asset: ${sourcePath}`);
  return path;
}).sort();

export async function seedSamplePack(doc: Y.Doc): Promise<void> {
  const loaded = await Promise.all(Object.entries(sampleAssets).map(async ([sourcePath, url]) => {
    const path = logicalSamplePath(sourcePath);
    if (!path) throw new Error(`Unexpected sample asset: ${sourcePath}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load sample asset: ${path}`);
    return [path, new Uint8Array(await response.arrayBuffer())] as const;
  }));
  for (const [path, bytes] of loaded) writeKitchenBytes(doc, path, bytes);
}
