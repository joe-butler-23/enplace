import { describe, expect, it } from "vitest";
import { compareCaptures, sha256, validateCapture, validateManifest } from "./recipe-clipper-compare.mjs";

const hash = sha256("fixture");
const score = { title: true, ingredients: true, instructions: true };
function fixture() {
  const cases = ["a/one.json", "b/two.json"].map(path => ({ path, domain: path[0] + ".test", split: "development", htmlSHA256: hash, referenceSHA256: hash }));
  const text = JSON.stringify({ repository: "https://example.test/corpus", commit: "a".repeat(40), cases });
  return {
    format: "enplace-recipe-clipper-replay-v1",
    source: { path: "/extractor.js", sha256: hash },
    harness: { replaySHA256: hash, compareSHA256: hash },
    environment: { node: "24.19.0", playwright: "1.58.2", chromium: "145" },
    manifest: { text, sha256: sha256(text) },
    pages: cases.map(entry => ({ path: entry.path, htmlSHA256: hash, referenceSHA256: hash, url: "https://example.test/recipe",
      candidates: [0, 1].map(index => ({ title: `Recipe ${index}`, ingredients: ["2 onions", "400 g tomatoes"], instructions: ["Mix.", "Bake."],
        description: "A recipe", notes: ["Serve hot"], yield: "2", imageURL: "https://example.test/photo.jpg", prepTime: "PT5M", cookTime: "PT20M",
        totalTime: "PT25M", nutrition: { calories: "50" }, sourceURL: "https://example.test/recipe", method: "json-ld", missing: [] })),
      legacyAgreement: { first: { ...score }, oracleBest: { ...score }, oracleBestIndex: 0 } })),
  };
}
const clone = value => structuredClone(value);
function changeManifest(capture, transform) {
  const manifest = JSON.parse(capture.manifest.text);
  transform(manifest);
  capture.manifest.text = JSON.stringify(manifest);
  capture.manifest.sha256 = sha256(capture.manifest.text);
}

describe("exact RecipeClipper replay comparison", () => {
  it("accepts equal outputs with different extractor hashes/paths and page/object-key order", () => {
    const a = fixture(), b = clone(a);
    b.source = { path: "/ablation.js", sha256: sha256("other source") };
    b.pages.reverse();
    b.pages[0].candidates[0] = Object.fromEntries(Object.entries(b.pages[0].candidates[0]).reverse());
    const result = compareCaptures(a, b);
    expect(result.equivalent).toBe(true);
    expect(result.legacyAgreement.before.first.matchingFields).toBe(6);
    expect(result.legacyAgreement.before.extraCandidates).toBe(2);
  });

  it.each([
    ["ingredients", ["400 onions", "2 g tomatoes"]], ["instructions", ["Bake.", "Mix."]],
    ["imageURL", "https://example.test/new.jpg"], ["prepTime", "PT1H"], ["cookTime", "PT2H"], ["totalTime", "PT3H"],
    ["nutrition", { calories: "500" }], ["sourceURL", "https://example.test/other"], ["description", "Changed"],
    ["notes", ["Cold"]], ["yield", "20"], ["futureField", { nested: ["new"] }],
  ])("detects nonselected-candidate %s without projecting fields", (field, value) => {
    const a = fixture(), b = clone(a);
    b.pages[0].candidates[1][field] = value;
    const result = compareCaptures(a, b);
    expect(result.equivalent).toBe(false);
    expect(result.changes[0].candidates[0]).toEqual({ index: 1, changedFields: [field], before: a.pages[0].candidates[1], after: b.pages[0].candidates[1] });
    expect(result.legacyAgreement.before).toEqual(result.legacyAgreement.after);
  });

  it.each(["remove candidate", "add candidate", "reorder candidates", "remove field", "null field", "row boundaries"])("detects %s", operation => {
    const a = fixture(), b = clone(a), candidates = b.pages[0].candidates;
    if (operation === "remove candidate") candidates.pop();
    if (operation === "add candidate") candidates.push({ title: "extra" });
    if (operation === "reorder candidates") candidates.reverse();
    if (operation === "remove field") delete candidates[1].description;
    if (operation === "null field") candidates[1].description = null;
    if (operation === "row boundaries") candidates[1].instructions = ["Mix. Bake."];
    expect(compareCaptures(a, b).equivalent).toBe(false);
  });

  it.each(["missing A page", "missing B page", "duplicate page", "unexpected page", "missing candidates", "null candidate", "error", "missing scores", "invalid oracle"])("rejects %s", operation => {
    const a = fixture(), b = clone(a);
    if (operation === "missing A page") a.pages.pop();
    if (operation === "missing B page") b.pages.pop();
    if (operation === "duplicate page") b.pages[1] = clone(b.pages[0]);
    if (operation === "unexpected page") b.pages[0].path = "unknown/page.json";
    if (operation === "missing candidates") delete b.pages[0].candidates;
    if (operation === "null candidate") b.pages[0].candidates[1] = null;
    if (operation === "error") b.pages[0].error = "failed";
    if (operation === "missing scores") delete b.pages[0].legacyAgreement;
    if (operation === "invalid oracle") b.pages[0].legacyAgreement.oracleBestIndex = 4;
    expect(() => compareCaptures(a, b)).toThrow();
  });

  it.each(["manifest bytes", "manifest order", "manifest path set", "manifest hash", "HTML hash", "reference hash", "URL", "source hash", "scorer", "environment"])("rejects changed/missing %s", operation => {
    const a = fixture(), b = clone(a);
    if (operation === "manifest bytes") changeManifest(b, m => { m.description = "different"; });
    if (operation === "manifest order") changeManifest(b, m => m.cases.reverse());
    if (operation === "manifest path set") { changeManifest(b, m => m.cases.pop()); b.pages.pop(); }
    if (operation === "manifest hash") b.manifest.sha256 = hash;
    if (operation === "HTML hash") b.pages[0].htmlSHA256 = sha256("changed HTML");
    if (operation === "reference hash") b.pages[0].referenceSHA256 = sha256("changed reference");
    if (operation === "URL") b.pages[0].url = "https://example.test/other";
    if (operation === "source hash") delete b.source.sha256;
    if (operation === "scorer") b.harness.replaySHA256 = sha256("new scorer");
    if (operation === "environment") b.environment.chromium = "other";
    expect(() => compareCaptures(a, b)).toThrow();
  });

  it.each([undefined, NaN, Infinity])("rejects output that JSON would silently change (%s)", value => {
    const capture = fixture();
    capture.pages[0].candidates[1].futureField = value;
    expect(() => validateCapture(capture)).toThrow(/lossless JSON/);
  });

  it("rejects fixture hashes changed consistently in both manifest and page", () => {
    const a = fixture(), b = clone(a), changed = sha256("changed HTML");
    changeManifest(b, m => { m.cases[0].htmlSHA256 = changed; });
    b.pages[0].htmlSHA256 = changed;
    expect(() => compareCaptures(a, b)).toThrow(/different manifest inputs/);
  });

  it("allows genuine abstention and reports first separately from oracle-best agreement", () => {
    const capture = fixture();
    capture.pages[0].legacyAgreement.first.title = false;
    capture.pages[0].legacyAgreement.oracleBestIndex = 1;
    capture.pages[1].candidates = [];
    capture.pages[1].legacyAgreement = { first: { title: false, ingredients: false, instructions: false }, oracleBest: { title: false, ingredients: false, instructions: false }, oracleBestIndex: null };
    expect(validateCapture(capture).size).toBe(2);
    const result = compareCaptures(capture, clone(capture));
    expect(result.legacyAgreement.before).toMatchObject({ emptyPages: 1, first: { matchingFields: 2, completePages: 0 }, oracleBest: { matchingFields: 3, completePages: 1 } });
  });

  it.each(["../secret.json", "/absolute.json", "a/../secret.json", "a\\secret.json", "a//secret.json"])("rejects unsafe manifest path %s", path => {
    const manifest = JSON.parse(fixture().manifest.text);
    manifest.cases[0].path = path;
    expect(() => validateManifest(manifest)).toThrow(/unsafe fixture path/);
  });
  it("rejects empty and duplicate manifests", () => {
    const manifest = JSON.parse(fixture().manifest.text);
    manifest.cases[1] = clone(manifest.cases[0]);
    expect(() => validateManifest(manifest)).toThrow(/duplicate/);
    manifest.cases = [];
    expect(() => validateManifest(manifest)).toThrow(/nonempty/);
  });
});
