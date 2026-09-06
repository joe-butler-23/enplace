#!/usr/bin/env node
// Run from the repository root. Corpus is external; only manifest-selected pages are read.
// Usage: node scripts/recipe-clipper-replay.mjs --output=/tmp/current.json
//   [--source=/tmp/baseline.js] [--corpus=/path/to/tests/test_data] [--manifest=/path/to/manifest.json]
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sha256, validateManifest, summarizeAgreement } from "./recipe-clipper-compare.mjs";

// Keep this legacy normalized-reference agreement unchanged from RecipeClipper test/corpus.js.
// It is NOT semantic accuracy: it flattens rows, folds case and permits omitted instruction labels.
export function extractAndScore({ html, reference, domain }) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const normalize = value => {
    const template = doc.createElement("template"); template.innerHTML = String(value ?? "");
    return template.content.textContent.replace(/\s+/g, " ").trim().toLowerCase();
  };
  const compare = (r, field) => {
    const expected = reference[({ instructions: "instructions_list" })[field] || field];
    const actual = r[field];
    const target = normalize(Array.isArray(expected) ? expected.join(" ") : expected);
    const variants = field === "instructions" ? [
      (actual || []).map(s => s.replace(/^\[(.*)\]$/, "$1")).join(" "),
      (actual || []).filter(s => !/^\[.*\]$/.test(s)).join(" "),
    ] : [Array.isArray(actual) ? actual.join(" ") : actual];
    return variants.some(value => normalize(value) === target);
  };
  const url = new URL(reference.canonical_url, `https://${domain}`).href;
  const candidates = globalThis.recipeClipper.clipRecipes(doc, { url });
  const scores = candidates.map(recipe => Object.fromEntries(["title", "ingredients", "instructions"].map(field => [field, compare(recipe, field)])));
  const count = score => Object.values(score).filter(Boolean).length;
  // Stable tie-breaking, as in the original stable Array.sort: first candidate wins ties.
  const oracleBestIndex = scores.length ? scores.reduce((best, score, index) => count(score) > count(scores[best]) ? index : best, 0) : null;
  const empty = { title: false, ingredients: false, instructions: false };
  return { url, candidates, legacyAgreement: { first: scores[0] ?? empty,
    oracleBest: scores[oracleBestIndex] ?? empty, oracleBestIndex } };
}

export async function replay(options) {
  assert(options.output, "--output is required (a new capture file; never overwrites)");
  const manifestPath = resolve(options.manifest ?? "tests/recipe-clipper-corpus/round10-manifest.json");
  const sourcePath = resolve(options.source ?? "src/recipe-import/recipe-clipper.js");
  const corpusPath = resolve(options.corpus ?? process.env.RECIPE_CORPUS ?? "/tmp/recipeclipper-corpus/tests/test_data");
  const [manifestText, source, replayBytes, compareBytes] = await Promise.all([
    readFile(manifestPath, "utf8"), readFile(sourcePath), readFile(new URL(import.meta.url)),
    readFile(new URL("./recipe-clipper-compare.mjs", import.meta.url)),
  ]);
  const manifest = validateManifest(JSON.parse(manifestText));
  // Reuse the project's exact Node, installed Playwright and Nix-browser contract.
  await import("./check-playwright-runtime.mjs");
  const { chromium } = await import("@playwright/test");
  const playwright = JSON.parse(await readFile("node_modules/playwright-core/package.json", "utf8")).version;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    // A single self-contained ES module: import exactly the bytes whose hash is recorded.
    // Relative imports fail instead of silently adding untracked source dependencies.
    await page.evaluate(async sourceURL => { globalThis.recipeClipper = await import(sourceURL); },
      `data:text/javascript;base64,${source.toString("base64")}`);
    const capture = {
      format: "enplace-recipe-clipper-replay-v1",
      source: { path: sourcePath, sha256: sha256(source) },
      manifest: { path: manifestPath, sha256: sha256(manifestText), text: manifestText },
      harness: { replaySHA256: sha256(replayBytes), compareSHA256: sha256(compareBytes) },
      environment: { node: process.versions.node, playwright, chromium: browser.version() },
      pages: [],
    };
    for (const entry of manifest.cases) {
      const [html, referenceBytes] = await Promise.all([
        readFile(resolve(corpusPath, entry.path.replace(/\.json$/, ".testhtml"))),
        readFile(resolve(corpusPath, entry.path)),
      ]);
      const htmlSHA256 = sha256(html), referenceSHA256 = sha256(referenceBytes);
      assert.equal(htmlSHA256, entry.htmlSHA256, `${entry.path}: changed HTML input`);
      assert.equal(referenceSHA256, entry.referenceSHA256, `${entry.path}: changed reference input`);
      let result;
      try {
        result = await page.evaluate(extractAndScore, { html: html.toString("utf8"), reference: JSON.parse(referenceBytes.toString("utf8")), domain: entry.domain });
      } catch (error) { throw new Error(`${entry.path}: extraction/scoring failed`, { cause: error }); }
      capture.pages.push({ path: entry.path, htmlSHA256, referenceSHA256, ...result });
    }
    const legacyAgreement = summarizeAgreement(capture);
    // No partial capture is published after an input or extractor failure.
    await writeFile(resolve(options.output), JSON.stringify(capture, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ output: resolve(options.output), source: capture.source,
      manifestSHA256: capture.manifest.sha256, legacyAgreement }, null, 2));
    return capture;
  } finally { await browser.close(); }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(["output", "source", "corpus", "manifest"].map(key => [key, { type: "string" }])) });
    await replay(values);
  } catch (error) {
    console.error(error.stack);
    if (error.cause) console.error(error.cause.stack);
    process.exitCode = 2;
  }
}
