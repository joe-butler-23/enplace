// Two packs, split by what first paint needs.
//
// sample-pack.pack is what the grid needs to render: every recipe and its 448px card
// thumbnail. sample-covers.pack carries the full-size covers, which only the recipe page
// shows, so seeding fetches it after mount instead of holding the first paint behind it.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readDirectory(directory, toLogicalPath) {
  const names = (await readdir(path.join(root, "sample", directory))).sort();
  return Promise.all(names.map(async (name) => [
    toLogicalPath(name),
    await readFile(path.join(root, "sample", directory, name)),
  ]));
}

async function writePack(name, entries) {
  const manifest = Buffer.from(JSON.stringify(entries.map(([entryPath, bytes]) => [entryPath, bytes.length])));
  const header = Buffer.alloc(8);
  header.write("MEP1", 0, "ascii");
  header.writeUInt32LE(manifest.length, 4);
  const pack = Buffer.concat([header, manifest, ...entries.map(([, bytes]) => bytes)]);
  await writeFile(path.join(root, "sample", name), pack);
  return { name, entries: entries.length, bytes: pack.length };
}

const recipes = await readDirectory("recipes", (name) => name);
const images = await readDirectory("images", (name) => `images/${name}`);
const thumbnails = images.filter(([entryPath]) => entryPath.endsWith(".card.webp"));
const covers = images.filter(([entryPath]) => !entryPath.endsWith(".card.webp"));

console.log(JSON.stringify([
  await writePack("sample-pack.pack", [...recipes, ...thumbnails]),
  await writePack("sample-covers.pack", covers),
]));
