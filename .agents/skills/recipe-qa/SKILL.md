---
name: recipe-qa
description: Compare an existing Enplace recipe with its recorded source without changing any recipe, plan, or shopping file. Do not use to extract or add a new recipe.
---

# Recipe QA

Review existing recipe Markdown without writing files or changing remote state.

1. Resolve the requested recipe path inside the selected Enplace folder. For a batch, sort paths before review.
2. Read the recipe and run `mep check <file> --folder <folder>`. This command validates only; do not run `mep add` or `mep shop`.
3. Read the recipe's recorded `source`. If it is absent or cannot be retrieved read-only, report `UNVERIFIED`; never guess or replace it.
4. Compare the source with the title, ingredient names, quantities, units, preparation notes, method steps, and their order. Confirm each ingredient line follows the [recipe-extraction ingredient convention](../recipe-extraction/SKILL.md); flag a violation as a mismatch.
5. Report each recipe as `PASS`, `FAIL`, or `UNVERIFIED`. For every mismatch, give its severity, source evidence in your own words, and the affected Markdown line or section.
6. Finish with pass, fail, and unverified counts. Keep batch output in sorted path order.

Do not edit recipes, `Plan.md`, `Shopping.md`, repository files, configuration, or remote content. A requested repair is a separate task.
