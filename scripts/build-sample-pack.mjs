import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectories = ["recipes", "images"];
const entries = [];
for (const directory of sourceDirectories) {
  const names = (await readdir(path.join(root, "sample", directory))).sort();
  for (const name of names) {
    const logicalPath = directory === "recipes" ? name : `images/${name}`;
    entries.push([logicalPath, await readFile(path.join(root, "sample", directory, name))]);
  }
}
const manifest = Buffer.from(JSON.stringify(entries.map(([entryPath, bytes]) => [entryPath, bytes.length])));
const header = Buffer.alloc(8);
header.write("MEP1", 0, "ascii");
header.writeUInt32LE(manifest.length, 4);
await writeFile(path.join(root, "sample", "sample-pack.pack"), Buffer.concat([header, manifest, ...entries.map(([, bytes]) => bytes)]));
