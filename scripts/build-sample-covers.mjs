import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "sample", "images");
const sourceRevision = "1291067";
// Mirrors COVER_QUALITY and THUMBNAIL_QUALITY in src/cookbook/covers.ts: a sample cover is
// encoded exactly as the browser would encode the same image on import.
const coverQuality = "82";
const thumbnailQuality = "70";
const names = [
  "banana-oat-loaf.webp",
  "beef-pepper-noodles.webp",
  "chicken-mushroom-risotto.webp",
  "chickpea-coconut-curry.webp",
  "lemon-chicken-traybake.webp",
  "mustard-salmon-potatoes.webp",
  "roast-vegetable-couscous-salad.webp",
  "sausage-apple-bake.webp",
  "smoky-lentil-soup.webp",
  "spinach-feta-omelette.webp",
  "white-bean-tomato-stew.webp",
];

if (!process.env.MEP_SAMPLE_COVER_ENCODERS) {
  const result = await run("nix", [
    "shell", "nixpkgs#imagemagick", "nixpkgs#libwebp", "--command", "env",
    "MEP_SAMPLE_COVER_ENCODERS=1", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { stdio: "inherit" });
  process.exit(result.code);
}

const sourceArgument = process.argv.indexOf("--source-dir");
const suppliedSourceDirectory = sourceArgument >= 0 ? path.resolve(process.argv[sourceArgument + 1]) : null;
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "enplace-sample-covers-"));
const sourceDirectory = suppliedSourceDirectory ?? path.join(temporaryDirectory, "originals");
const workingDirectory = path.join(temporaryDirectory, "work");
await mkdir(sourceDirectory, { recursive: true });
await mkdir(workingDirectory, { recursive: true });
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

try {
  if (!suppliedSourceDirectory) {
    for (const name of names) {
      const original = execFileSync("git", ["show", `${sourceRevision}:sample/images/${name}`], { cwd: root });
      await writeFile(path.join(sourceDirectory, name), original);
    }
  }
  for (const name of names) {
    const stem = name.replace(/\.webp$/, "");
    const original = path.join(sourceDirectory, name);
    const cappedPng = path.join(workingDirectory, `${stem}.png`);
    const thumbnailPng = path.join(workingDirectory, `${stem}.card.png`);
    await mustRun("magick", [original, "-auto-orient", "-resize", "1280x1280>", cappedPng]);
    await mustRun("magick", [original, "-auto-orient", "-resize", "448x448^", "-gravity", "center", "-extent", "448x448", thumbnailPng]);
    await mustRun("cwebp", ["-quiet", "-q", coverQuality, cappedPng, "-o", path.join(outputDirectory, name)]);
    await mustRun("cwebp", ["-quiet", "-q", thumbnailQuality, thumbnailPng, "-o", path.join(outputDirectory, `${stem}.card.webp`)]);
  }
  const files = await Promise.all((await readdir(outputDirectory)).sort()
    .map(async (name) => ({ name, bytes: (await readFile(path.join(outputDirectory, name))).length })));
  console.log(JSON.stringify({ status: "generated", longestSide: 1280, thumbnail: 448,
    coverQuality: Number(coverQuality), thumbnailQuality: Number(thumbnailQuality), files }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function mustRun(command, args) {
  const result = await run(command, args);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
