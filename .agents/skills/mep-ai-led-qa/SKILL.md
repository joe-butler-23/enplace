---
name: mep-ai-led-qa
description: Review existing recipe markdown against its source page without writing recipes or changing shopping state. Use for one existing recipe, a named batch, or this week's existing recipes; do not use for new-recipe extraction or importer implementation and release QA.
---

# Read-Only Existing-Recipe QA

This project skill is the sole authority for read-only quality review of existing recipe markdown. It returns evidence and recommendations without changing the recipe, repository, vault, or shopping state.

For a new recipe, stop this workflow and use `recipe-extraction`. Importer implementation and release QA must use isolated test directories under the repository working contract, never a live vault.

## User Requirements

- [ ] The agent must compare each selected recipe with the source page recorded in that recipe.
- [ ] The agent must report concrete source evidence and affected markdown lines for every finding.
- [ ] The agent must keep recipe selection and final report ordering deterministic.
- [ ] The agent must state which recipes passed, failed, or could not be verified.

## Constraints

- [ ] The agent must not modify recipe markdown, repository files, vault files, config, shopping artifacts, or remote state.
- [ ] The agent must not run `mep recipe import` or mutate the built-in shopping list.
- [ ] The agent must not substitute this workflow for new-recipe extraction, importer changes, or release QA.
- [ ] The agent must use no more than five parallel recipe reviewers and must sort their results before reporting.
- [ ] The agent must not mark a recipe `PASS` when its source could not be retrieved or its source URL is absent.

## Inputs and Selection

Accept either:

- explicit recipe slugs or markdown paths; or
- `this_week`, meaning recipes whose frontmatter `added` date is between local Monday and today, inclusive.

For explicit input, resolve paths beneath the supplied recipes directory, report missing files, and sort by path. For `this_week`, read every `*.md` frontmatter, select the inclusive date window, and sort by `added` date then filename. Do not write a generated selection file.

## Per-Recipe Procedure

1. Read the markdown and record its path and relevant line numbers.
2. Extract the title, source URL, `## Ingredients` pipe lines, and `## Method` steps.
3. Fetch the source page without submitting forms or invoking a mutating endpoint.
4. Compare:
   - title and source identity
   - missing or hallucinated ingredients
   - quantities and units
   - configured-label validity
   - method fidelity and ordering
   - strict `quantity | ingredient | label` structure
5. Flag likely ignore, merge, deduplication, or summing risks as recommendations only. Do not generate or change shopping state.
6. Assign one result:
   - `PASS`: no material mismatch found
   - `FAIL`: at least one extraction or format defect found
   - `UNVERIFIED`: the source URL is missing or the source could not be retrieved

## Output Contract

Report each recipe in deterministic selection order with:

- result and recipe path
- severity-tagged findings: `critical`, `major`, or `minor`
- source evidence summarized in the agent's own words
- affected markdown line numbers or section
- smallest likely fix surface: extraction skill, import validation, deterministic shopping logic, or config

Finish with checked/pass/fail/unverified counts and cross-recipe patterns. Do not edit a recipe automatically; a requested fix is a separate, explicitly authorized workflow.

## Acceptance Checks

- [ ] Run `clai validate skill mep-ai-led-qa --scope project --project-root .` and expect no `[Error]` lines.
- [ ] Given an existing recipe and a retrievable source page, when this skill is followed, then the report includes a result, severity-tagged findings, source evidence, and markdown locations without any write command.
- [ ] Given `this_week`, when this skill is followed, then only recipes inside the inclusive local Monday-to-today window are reported, ordered by `added` then filename.
- [ ] Given a new-recipe request, when this skill is selected, then it routes to `recipe-extraction`; importer or release QA stops before any live-vault write.

## Regression Checks

- [ ] Run `clai validate all --scope project --project-root .` and expect this skill to introduce no hard validation failure.
- [ ] Run `clai sync --dry-run --scope project --project-root .` and expect project skill projections only; do not apply the sync during read-only QA.
- [ ] Given any existing-recipe QA request, when this skill is followed, then none of the prohibited `mep` mutation commands are invoked.
