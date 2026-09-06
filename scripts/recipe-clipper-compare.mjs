#!/usr/bin/env node
// Exact JSON API comparison. Manifest bytes and environment must match; extractor hashes may differ.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fields = ["title", "ingredients", "instructions"];
const hashPattern = /^[a-f0-9]{64}$/;
const validHash = (value, label) => assert.match(value ?? "", hashPattern, `${label}: missing/invalid SHA256`);

export function validateManifest(manifest) {
  assert.equal(typeof manifest.repository, "string", "manifest repository missing");
  assert.match(manifest.commit ?? "", /^[a-f0-9]{40}$/, "manifest commit missing/invalid");
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, "manifest cases must be nonempty");
  const paths = new Set();
  for (const entry of manifest.cases) {
    assert(typeof entry.path === "string" && /^[^\\]+\.json$/.test(entry.path)
      && !entry.path.startsWith("/") && !entry.path.split("/").some(p => !p || p === "." || p === ".."), "unsafe fixture path");
    assert(!paths.has(entry.path), `duplicate manifest path: ${entry.path}`);
    paths.add(entry.path);
    for (const key of ["domain", "split"]) assert(typeof entry[key] === "string" && entry[key], `${entry.path}: missing ${key}`);
    validHash(entry.htmlSHA256, entry.path);
    validHash(entry.referenceSHA256, entry.path);
  }
  return manifest;
}

export function validateCapture(capture) {
  assert.equal(capture?.format, "enplace-recipe-clipper-replay-v1", "unsupported capture format");
  validHash(capture.source?.sha256, "extractor");
  validHash(capture.harness?.replaySHA256, "replay/scorer");
  validHash(capture.harness?.compareSHA256, "validation/comparison");
  for (const key of ["node", "playwright", "chromium"]) {
    assert(typeof capture.environment?.[key] === "string" && capture.environment[key], `missing environment ${key}`);
  }
  assert.equal(typeof capture.manifest?.text, "string", "missing manifest text");
  assert.equal(sha256(capture.manifest.text), capture.manifest.sha256, "manifest hash mismatch");
  const manifest = validateManifest(JSON.parse(capture.manifest.text));
  assert(Array.isArray(capture.pages), "missing pages");
  assert.equal(capture.pages.length, manifest.cases.length, "capture/manifest path sets differ");
  const entries = new Map(manifest.cases.map(entry => [entry.path, entry]));
  const pages = new Map();
  for (const page of capture.pages) {
    assert(!pages.has(page.path), `duplicate capture path: ${page.path}`);
    const entry = entries.get(page.path);
    assert(entry, `unexpected capture path: ${page.path}`);
    for (const key of ["htmlSHA256", "referenceSHA256"]) assert.equal(page[key], entry[key], `${page.path}: ${key} mismatch`);
    assert.equal(typeof page.url, "string", `${page.path}: missing resolved input URL`);
    assert(["https:", "http:"].includes(new URL(page.url).protocol), `${page.path}: invalid input URL`);
    assert(!Object.hasOwn(page, "error"), `${page.path}: extraction failed`);
    assert(Array.isArray(page.candidates), `${page.path}: missing candidates`);
    assert(page.candidates.every(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate)), `${page.path}: invalid candidate`);
    assert(isDeepStrictEqual(page.candidates, JSON.parse(JSON.stringify(page.candidates))), `${page.path}: candidate output is not lossless JSON`);
    for (const kind of ["first", "oracleBest"]) {
      assert.deepEqual(Object.keys(page.legacyAgreement?.[kind] ?? {}).sort(), [...fields].sort(), `${page.path}: missing ${kind} scores`);
      for (const field of fields) assert.equal(typeof page.legacyAgreement[kind][field], "boolean", `${page.path}: invalid score`);
    }
    const index = page.legacyAgreement.oracleBestIndex;
    assert(page.candidates.length ? Number.isInteger(index) && index >= 0 && index < page.candidates.length : index === null, `${page.path}: invalid oracle index`);
    if (!page.candidates.length) assert(fields.every(field => !page.legacyAgreement.first[field] && !page.legacyAgreement.oracleBest[field]), `${page.path}: empty page has positive scores`);
    pages.set(page.path, page);
  }
  return pages;
}

export function summarizeAgreement(capture) {
  const pages = validateCapture(capture);
  const summary = { pages: pages.size, providedFields: pages.size * 3, emptyPages: 0, extraCandidates: 0,
    first: { matchingFields: 0, completePages: 0 }, oracleBest: { matchingFields: 0, completePages: 0 } };
  for (const page of pages.values()) {
    summary.emptyPages += Number(page.candidates.length === 0);
    summary.extraCandidates += Math.max(0, page.candidates.length - 1);
    for (const kind of ["first", "oracleBest"]) {
      const matches = fields.filter(field => page.legacyAgreement[kind][field]).length;
      summary[kind].matchingFields += matches;
      summary[kind].completePages += Number(matches === 3);
    }
  }
  return summary;
}

export function compareCaptures(before, after) {
  const a = validateCapture(before), b = validateCapture(after);
  // Strict manifest-byte identity also rejects changed metadata, ordering or selection.
  assert.equal(before.manifest.sha256, after.manifest.sha256, "different manifest inputs");
  assert.deepEqual(before.harness, after.harness, "different replay/scorer/comparison contract");
  assert.deepEqual(before.environment, after.environment, "different browser/Node/Playwright environment");
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "different capture path sets");
  const changes = [];
  for (const [path, oldPage] of a) {
    const newPage = b.get(path);
    for (const key of ["htmlSHA256", "referenceSHA256", "url"]) assert.equal(oldPage[key], newPage[key], `${path}: different ${key} input`);
    const candidates = [];
    for (let index = 0; index < Math.max(oldPage.candidates.length, newPage.candidates.length); index++) {
      const oldValue = oldPage.candidates[index], newValue = newPage.candidates[index];
      if (isDeepStrictEqual(oldValue, newValue)) continue;
      const changedFields = [...new Set([...Object.keys(oldValue ?? {}), ...Object.keys(newValue ?? {})])]
        .filter(field => !isDeepStrictEqual(oldValue?.[field], newValue?.[field]) || Object.hasOwn(oldValue ?? {}, field) !== Object.hasOwn(newValue ?? {}, field));
      candidates.push({ index, changedFields, before: oldValue ?? null, after: newValue ?? null });
    }
    if (candidates.length || !isDeepStrictEqual(oldPage.legacyAgreement, newPage.legacyAgreement)) {
      changes.push({ path, candidates, legacyAgreement: { before: oldPage.legacyAgreement, after: newPage.legacyAgreement } });
    }
  }
  return { equivalent: changes.length === 0, changedPages: changes.length,
    sources: { before: before.source, after: after.source },
    legacyAgreement: { before: summarizeAgreement(before), after: summarizeAgreement(after) }, changes };
}

if (import.meta.main) {
  try {
    const paths = process.argv.slice(2);
    assert.equal(paths.length, 2, "Usage: node scripts/recipe-clipper-compare.mjs before.json after.json");
    const [before, after] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, "utf8"))));
    const result = compareCaptures(before, after);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.equivalent ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
