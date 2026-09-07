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
The 2026-09-06 corpus replay changed only EatingWell and Martha Stewart ingredient
arrays and their extraction-method provenance for this reason. Legacy agreement
rose by two fields, **not** two newly recovered recipes or proof of semantic gain.

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

## Rejected shared prose-reader trial — 2026-09-06

**Retain the existing printed-prose path.** A shared shape reader replaced the
separate printed reader with heading-owned rows and prose. The frozen 24-case
pilot improved from 16 to 21 matches and retained every baseline passing gate.
The broader oracle rejected it:

- Historical browser behavior tests: safety baseline **117/117**, candidate
  **116/117**. Blank structured fields caused valid card steps to be replaced
  with `Freeze leftovers.` and `120 kcal`.
- Two independent recipe-like negatives: baseline **2/2**, candidate **0/2**.
  Product specifications plus sales prose, and a shopping list plus an errand,
  became complete recipes. The baseline's explicit incomplete candidates did not.
- Whole-file size fell 129 bytes/3 lines, but removing blank lines and full-line
  comments exposed growth of **737 bytes/5 executable lines**. This was not a
  demonstrated reduction in implementation complexity.

One candidate and two corrections exhausted the registered budget. The safety
stop rule ended the trial before a full corpus or timing campaign for that
candidate; those gates are **not** claimed to pass. No candidate code entered
production. Reopen only with a mechanism that resolves both recipe admission and
method ownership without phrase/site patches, passes these negatives and the
card-enrichment regression, and reduces executable machinery rather than comments.

[Evidence](evidence/recipe-clipper-2026-09-06/summary.json) records source identities,
publication copies of logs and the two-field corpus difference. Local repository
paths are redacted as `<repo>`; original raw hashes are recorded in the summary.
`rejected-trial.tar.gz` preserves the frozen sources, fixtures, driver and
pilot/adversarial results with the same path-only redaction. Its scratch
driver's Playwright import path needs local resolution; the project scripts
above are the supported corpus interface. The three decisive negative/regression
cases now run in the normal unit suite. Beads `mise-en-place-jrv` owns the work;
`mise-en-place-jrv.1` owns the harness and `mise-en-place-jrv.2` records the trial.

## Unfamiliar-page source audit — 2026-09-06

[Eight recipes and four non-recipe controls](recipe-clipper-fresh-audit-2026-09-06.md)
were independently annotated before testing the unchanged release. All required
ingredient amounts and cooking steps survived, but commercial/page text crossed
field boundaries, two ingredient groups were lost, and all six explicit overall
serving counts were omitted. This is new baseline evidence, not an accuracy gain;
field ownership is the highest-value next target. The rejected trial remains closed.
