# RecipeClipper: ownership, verification and measured decisions

Enplace maintains `src/recipe-import/recipe-clipper.js`. It descends from the MIT
RecipeClipper browser rewrite at `e7b9efb`; its header preserves attribution.
The standalone repository is historical context, not a second editing authority.
The API remains synchronous, dependency-free and network-free.

## Source fidelity

A visible ingredient row may lend its numeral spelling to structured data only
when the corresponding numeral values and their order agree. A bag of words and
numbers establishes neither quantity attachment nor recipe meaning. In particular,
`2.0 onions, 400 g` must not become `400 onions, 2 g` merely because the page
renders `400 g onions, 2`. Row identity no longer rounds amounts to hundredths.

This is deliberately conservative. `0.333` and `⅓` are not exactly the same value;
that ambiguity leaves the serialized list untouched rather than rewriting it.

## Repeatable checks

Use the Node and browser environment from `nix develop`:

```sh
npm test -- src/recipe-import/recipe-clipper.test.ts scripts/recipe-clipper-compare.test.mjs
npm run test:static-pwa -- tests/static-pwa/import-page.spec.ts
node scripts/recipe-clipper-replay.mjs --output=/tmp/clipper-current.json
node scripts/recipe-clipper-replay.mjs --source=/path/to/baseline.js --output=/tmp/clipper-baseline.json
node scripts/recipe-clipper-compare.mjs /tmp/clipper-baseline.json /tmp/clipper-current.json
```

The corpus is optional external test data from `hhursev/recipe-scrapers` at
`d08ddd0240ee0ff73dd9d705e43077a821944716`. Pass `--corpus=/path/to/tests/test_data`
(or `RECIPE_CORPUS`); default is `/tmp/recipeclipper-corpus/tests/test_data`.
Only the 967 already exposed pages selected in
`tests/recipe-clipper-corpus/round10-manifest.json` are opened. HTML and reference
hashes must match. No runtime or normal unit test downloads corpus data.

Replay stores all candidates and all JSON API fields, input hashes, exact source
bytes' hash, scorer/comparator hashes and browser/tool versions. It blocks network
requests, fails on extraction errors and refuses to overwrite captures. Compare
requires identical input and measurement contracts; exit 0 means equal outputs,
1 means differences (full payloads printed), and 2 means invalid evidence.

Legacy normalized-reference agreement remains a diagnostic: it flattens rows,
folds case and ignores some instruction labels. Both first-candidate and
oracle-best scores are reported. Neither is semantic correctness. Multi-recipe
pages need all-recipe annotations before extra candidates can be called errors.

The old reports' claim of corpus exhaustion was wrong: Round 9 recorded 139
eligible leftovers, all on domains subsequently observed. Their exposure history
is not fully established. They remain unopened here; fresh-domain validation and
independent comparisons are still needed for any world-leading accuracy claim.

## Retained printed-prose reader

Retain the separate printed-prose path until a replacement proves both recipe
admission and method ownership without site/phrase patches. The rejected shared
reader replaced valid card steps with notes/nutrition, admitted product and
shopping pages as recipes, and grew executable code despite a smaller whole file.
The three decisive cases run in the normal unit suite. Reopening requires passing
those cases and reducing executable machinery; a narrower pilot is insufficient.

Historical decision and frozen candidate evidence are in commit
`ea3016393f8d5d0f71e3eda5114403ec55e002d4` (Bead `mise-en-place-jrv.2`):

```sh
git show ea3016393f8d5d0f71e3eda5114403ec55e002d4:docs/recipe-clipper.md
git show ea3016393f8d5d0f71e3eda5114403ec55e002d4:docs/evidence/recipe-clipper-2026-09-06/rejected-trial.tar.gz > /tmp/clipper-rejected-trial.tar.gz
```
