# Sample vault

This folder is a small Enplace vault with recipes, planning and shopping examples.

## Recipes

Any Markdown file with an `## Ingredients` heading is a recipe.
Use YAML frontmatter for a title and optional tags, then add a one-line description.
Write ingredients as plain Markdown list items, quantity first: `- 2 tbsp olive oil`.
Use numbered steps under `## Method`.

## Plan.md

Put saved recipe links under `## Marked`.
Add one `## YYYY-MM-DD` heading per planned day and place `[[recipe-file-stem]]` links beneath it.

## Shopping.md

Shopping is a `- [ ]` checklist that the app regenerates from the planned week.
Hand-written checklist lines are kept when the list is regenerated.

Add, mark, plan, shop, cook.
