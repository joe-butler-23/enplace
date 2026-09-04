import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "public", "samples");
const sourceRevision = "1291067";
const widths = [224, 672, 1288];
const qualityFloor = 0.97;
const images = [
  {
    "name": "banana-oat-loaf.webp",
    "webpQuality": 62,
    "avifCq": 36
  },
  {
    "name": "beef-pepper-noodles.webp",
    "webpQuality": 56,
    "avifCq": 38
  },
  {
    "name": "chicken-mushroom-risotto.webp",
    "webpQuality": 80,
    "avifCq": 30
  },
  {
    "name": "chickpea-coconut-curry.webp",
    "webpQuality": 45,
    "avifCq": 40
  },
  {
    "name": "lemon-chicken-traybake.webp",
    "webpQuality": 76,
    "avifCq": 33
  },
  {
    "name": "mustard-salmon-potatoes.webp",
    "webpQuality": 38,
    "avifCq": 41
  },
  {
    "name": "roast-vegetable-couscous-salad.webp",
    "webpQuality": 60,
    "avifCq": 36
  },
  {
    "name": "sausage-apple-bake.webp",
    "webpQuality": 77,
    "avifCq": 30
  },
  {
    "name": "smoky-lentil-soup.webp",
    "webpQuality": 60,
    "avifCq": 34
  },
  {
    "name": "spinach-feta-omelette.webp",
    "webpQuality": 65,
    "avifCq": 34
  },
  {
    "name": "white-bean-tomato-stew.webp",
    "webpQuality": 51,
    "avifCq": 37
  }
];

const manifestPath = path.join(root, "scripts", "sample-cover-manifest.json");
const generatorVersion = 1;
const buildKey = createHash("sha256").update(JSON.stringify({ generatorVersion, sourceRevision, widths, qualityFloor, images })).digest("hex");
const cachedManifest = await readManifest();
if (cachedManifest?.buildKey === buildKey && await outputsMatch(cachedManifest.outputs)) {
  console.log(JSON.stringify({ status: "current", buildKey, widths, files: cachedManifest.outputs.length }));
  process.exit(0);
}

if (!process.env.MEP_SAMPLE_COVER_ENCODERS) {
  const result = await run("nix", [
    "shell", "nixpkgs#libwebp", "nixpkgs#libavif", "--command", "env",
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
await mkdir(outputDirectory, { recursive: true });

try {
  if (!suppliedSourceDirectory) {
    for (const image of images) {
      const original = execFileSync("git", ["show", `${sourceRevision}:sample/images/${image.name}`], { cwd: root });
      await writeFile(path.join(sourceDirectory, image.name), original);
    }
  }

  const results = await mapLimit(images, 2, buildImage);
  const manifest = { buildKey, sourceRevision, widths, qualityFloor, images: results, outputs: await describeOutputs() };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ status: "generated", buildKey, widths, files: manifest.outputs.length }));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function readManifest() {
  try { return JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { return null; }
}

function outputNames() {
  return images.flatMap((image) => {
    const stem = image.name.replace(/\.webp$/, "");
    return [image.name, ...widths.flatMap((width) => [`${stem}-${width}.avif`, `${stem}-${width}.webp`])];
  });
}

async function describeOutputs() {
  return Promise.all(outputNames().map(async (name) => {
    const bytes = await readFile(path.join(outputDirectory, name));
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
}

async function outputsMatch(outputs) {
  if (!Array.isArray(outputs) || outputs.length !== outputNames().length) return false;
  const expected = new Map(outputs.map((output) => [output.name, output]));
  try {
    for (const name of outputNames()) {
      const bytes = await readFile(path.join(outputDirectory, name));
      const record = expected.get(name);
      if (!record || record.bytes !== bytes.length || record.sha256 !== createHash("sha256").update(bytes).digest("hex")) return false;
    }
    return true;
  } catch { return false; }
}

async function buildImage(image) {
  const stem = image.name.replace(/\.webp$/, "");
  const original = path.join(sourceDirectory, image.name);
  const reference = path.join(workingDirectory, `${stem}-480.png`);
  const avifReference = path.join(workingDirectory, `${stem}-480.avif`);
  const webpFallback = path.join(outputDirectory, image.name);

  await mustRun("magick", [original, "-resize", "480x480", reference]);
  await mustRun("cwebp", ["-m", "6", "-q", String(image.webpQuality), "-af", "-sharp_yuv", "-mt", reference, "-o", webpFallback]);
  await mustRun("avifenc", avifArguments(image.avifCq, reference, avifReference));

  const webpMetric = await measure(reference, webpFallback);
  const avifMetric = await measure(reference, avifReference);
  if (webpMetric.ssim < qualityFloor || avifMetric.ssim < qualityFloor) {
    throw new Error(`${image.name} fell below SSIM ${qualityFloor}: WebP=${webpMetric.ssim}, AVIF=${avifMetric.ssim}`);
  }

  const variants = [];
  for (const width of widths) {
    const resized = path.join(workingDirectory, `${stem}-${width}.png`);
    const webp = path.join(outputDirectory, `${stem}-${width}.webp`);
    const avif = path.join(outputDirectory, `${stem}-${width}.avif`);
    await mustRun("magick", [original, "-resize", `${width}x${width}`, resized]);
    await Promise.all([
      mustRun("cwebp", ["-m", "6", "-q", String(image.webpQuality), "-af", "-sharp_yuv", "-mt", resized, "-o", webp]),
      mustRun("avifenc", avifArguments(image.avifCq, resized, avif)),
    ]);
    variants.push({
      width,
      webpBytes: (await readFile(webp)).length,
      avifBytes: (await readFile(avif)).length,
    });
  }

  return {
    name: image.name,
    webp: { quality: image.webpQuality, bytes: (await readFile(webpFallback)).length, ...webpMetric },
    avif: { cqLevel: image.avifCq, bytes: (await readFile(avifReference)).length, ...avifMetric },
    winner: (await readFile(avifReference)).length < (await readFile(webpFallback)).length ? "avif" : "webp",
    variants,
  };
}

function avifArguments(cqLevel, input, output) {
  return ["-s", "0", "-j", "all", "--min", "0", "--max", "63", "-a", "end-usage=q", "-a", `cq-level=${cqLevel}`, "-a", "tune=ssim", "-y", "444", input, output];
}

async function measure(reference, candidate) {
  const result = await run("magick", ["compare", "-metric", "SSIM", reference, candidate, "null:"]);
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || result.stdout);
  const match = `${result.stderr} ${result.stdout}`.match(/\(([0-9.eE+-]+)\)/);
  if (!match) throw new Error(`Could not parse SSIM output for ${candidate}: ${result.stderr} ${result.stdout}`);
  const normalizedDistortion = Number(match[1]);
  const ssim = 1 - normalizedDistortion;
  return { normalizedDistortion, ssim, dssim: (1 - ssim) / 2 };
}

async function mapLimit(values, concurrency, operation) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]);
    }
  }));
  return results;
}

async function mustRun(command, args) {
  const result = await run(command, args);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
  return result;
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
