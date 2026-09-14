# Page recipes: ownership, verification and measured decisions

Enplace maintains `src/recipe-import/page-recipes.js`. It is synchronous,
dependency-free, network-free, and reads a parsed `Document`.

## Source fidelity

A visible ingredient row may lend its numeral spelling to structured data only
when the corresponding numeral values and their order agree. A bag of words and
numbers establishes neither quantity attachment nor recipe meaning. In particular,
`2.0 onions, 400 g` must not become `400 onions, 2 g` merely because the page
renders `400 g onions, 2`. Row identity does not round amounts to hundredths.

This is deliberately conservative. `0.333` and `⅓` are not exactly the same value;
that ambiguity leaves the serialized list untouched rather than rewriting it.

## Repeatable checks

Use the Node and browser environment from `nix develop`:

```sh
npm test -- src/recipe-import/page-recipes.test.ts scripts/page-recipes-compare.test.mjs
npm run test:static-pwa -- tests/static-pwa/import-page.spec.ts
node scripts/page-recipes-replay.mjs --output=/tmp/page-recipes-current.json
node scripts/page-recipes-replay.mjs --source=/path/to/baseline.js --output=/tmp/page-recipes-baseline.json
node scripts/page-recipes-compare.mjs /tmp/page-recipes-baseline.json /tmp/page-recipes-current.json
```

The corpus is optional external test data. Pass `--corpus=/path/to/tests/test_data`
(or `RECIPE_CORPUS`); default is `/tmp/page-recipes-corpus/tests/test_data`.
Only the 967 already exposed pages selected in
`tests/page-recipes-corpus/corpus-manifest.json` are opened. HTML and reference
hashes must match. No runtime or normal unit test downloads corpus data.

Replay stores all candidates and all JSON API fields, input hashes, exact source
bytes' hash, scorer/comparator hashes and browser/tool versions. It blocks network
requests, fails on extraction errors and refuses to overwrite captures. Compare
requires identical input and measurement contracts; exit 0 means equal outputs,
1 means differences (full payloads printed), and 2 means invalid evidence.

Normalized-reference agreement remains a diagnostic: it flattens rows, folds case
and ignores some instruction labels. Both first-candidate and oracle-best scores
are reported. Neither is semantic correctness. Multi-recipe pages need all-recipe
annotations before extra candidates can be called errors.

The previous corpus inventory recorded 139 eligible unopened pages, all on domains
subsequently observed. Their exposure history is not fully established. They remain
unopened here; fresh-domain validation and independent comparisons are still needed
for any world-leading accuracy claim.

## Retained printed-prose reader

Retain the separate printed-prose path until a replacement proves both recipe
admission and method ownership without site/phrase patches. The rejected shared
reader replaced valid card steps with notes/nutrition, admitted product and
shopping pages as recipes, and grew executable code despite a smaller whole file.
The three decisive cases run in the normal unit suite. Reopening requires passing
those cases and reducing executable machinery; a narrower pilot is insufficient.

Historical decision and frozen candidate evidence are in commit
`ea3016393f8d5d0f71e3eda5114403ec55e002d4` (Bead `mise-en-place-jrv.2`).
