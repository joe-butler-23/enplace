#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const settingsDefaults = require("../src/settings.defaults.json");

export const RECIPE_SCROLL_FIXTURE_COUNT = 500;
const RECIPES_FOLDER = "recipes";
const IMAGES_FOLDER = `${RECIPES_FOLDER}/images`;
const IMAGE_WIDTH = 256;
const IMAGE_HEIGHT = 144;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, payload]);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(body));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([length, body, checksum]);
}

function fixturePng(index) {
  const pixels = Buffer.alloc((IMAGE_WIDTH * 4 + 1) * IMAGE_HEIGHT);
  let state = (0x9e3779b9 ^ index) >>> 0;
  const hue = (index * 47) % 256;
  for (let y = 0; y < IMAGE_HEIGHT; y += 1) {
    pixels[y * (IMAGE_WIDTH * 4 + 1)] = 0;
    for (let x = 0; x < IMAGE_WIDTH; x += 1) {
      state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x2718281) >>> 0;
      const noise = state & 31;
      const offset = y * (IMAGE_WIDTH * 4 + 1) + 1 + x * 4;
      pixels[offset] = (hue + x + noise) & 255;
      pixels[offset + 1] = (hue + y * 2 + noise) & 255;
      pixels[offset + 2] = (hue + x + y + 96 + noise) & 255;
      pixels[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_WIDTH, 0);
  header.writeUInt32BE(IMAGE_HEIGHT, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function recipeMarkdown(index) {
  const number = String(index + 1).padStart(3, "0");
  const day = String((index % 28) + 1).padStart(2, "0");
  return [
    "---",
    `title: \"Visual Fixture ${number}\"`,
    'type: "recipe"',
    `added: \"2026-06-${day}\"`,
    `marked: ${index % 7 === 0}`,
    `cover: \"images/visual-cover-${number}.png\"`,
    "---",
    "",
    `Deterministic raster image transport fixture ${index + 1}.`,
    `![Visual fixture image](images/visual-cover-${number}.png)`,
    ""
  ].join("\n");
}

export async function createRecipeScrollFixture({
  root = null,
  count = RECIPE_SCROLL_FIXTURE_COUNT
} = {}) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Fixture count must be a positive integer (got ${count}).`);
  }
  const fixtureRoot = root ?? await mkdtemp(path.join(tmpdir(), "mep-recipe-scroll-"));
  const vaultRoot = path.join(fixtureRoot, "vault");
  const appDataRoot = path.join(fixtureRoot, "appdata");
  const fixtureSettings = {
    ...settingsDefaults,
    recipesFolder: RECIPES_FOLDER,
    imagesFolder: IMAGES_FOLDER,
    vaultPath: "/home/vault",
    archiveFolder: settingsDefaults.archiveFolder || "inbox/archive",
  };
  const recipesRoot = path.join(vaultRoot, fixtureSettings.recipesFolder);
  const imagesRoot = path.join(vaultRoot, fixtureSettings.imagesFolder);
  await Promise.all([
    mkdir(imagesRoot, { recursive: true }),
    mkdir(path.join(vaultRoot, ".mep"), { recursive: true }),
    mkdir(path.join(vaultRoot, fixtureSettings.archiveFolder), { recursive: true }),
    mkdir(path.join(vaultRoot, fixtureSettings.eventsFolder), { recursive: true }),
    mkdir(appDataRoot, { recursive: true })
  ]);
  await writeFile(
    path.join(appDataRoot, "settings.json"),
    `${JSON.stringify(fixtureSettings, null, 2)}\n`,
    "utf8"
  );

  for (let index = 0; index < count; index += 1) {
    const number = String(index + 1).padStart(3, "0");
    await Promise.all([
      writeFile(path.join(recipesRoot, `visual-fixture-${number}.md`), recipeMarkdown(index), "utf8"),
      writeFile(path.join(imagesRoot, `visual-cover-${number}.png`), fixturePng(index))
    ]);
  }

  return {
    root: fixtureRoot,
    vaultRoot,
    appDataRoot,
    count,
    cleanup: async () => {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const output = process.argv[2] || null;
  const fixture = await createRecipeScrollFixture({ root: output });
  console.log(JSON.stringify({ root: fixture.root, vaultRoot: fixture.vaultRoot, appDataRoot: fixture.appDataRoot, count: fixture.count }));
}
