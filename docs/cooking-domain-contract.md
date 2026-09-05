# Cooking Domain Contract

The shared cookbook document is the complete cooking data authority. Paths in this contract are cookbook-relative; a folder exists only as a deliberate import or plain-file export.

## Recipes

New recipes use [RecipeMD 2.4](https://recipemd.org/specification.html). `src/recipemd.ts` parses CommonMark structure and is checked against every upstream conformance fixture. Existing frontmatter/`## Ingredients` recipes remain readable during migration; new imports write RecipeMD.

- Title: first level-one heading.
- Description: ordinary Markdown; a cover is an ordinary Markdown image and provenance is a `Source: ...` paragraph. An optional `Added: YYYY-MM-DD` paragraph preserves existing catalogue dates. Neither is required by RecipeMD.
- Tags: one wholly italic paragraph; yields: one wholly bold paragraph.
- Ingredients: lists between thematic breaks, with headings for groups. Explicit amounts are italic. Ingredient amounts and names project into readable shopping text; quantities are not automatically summed.
- Instructions: Markdown after the second thematic break. Prose, groups and notes remain readable.
- Relative images resolve from the recipe path in the cookbook document.

Use UK ingredient names, g/kg, ml/l and °C for new UK recipes; tsp/tbsp remain useful. Source weights take precedence over volume conversions. Do not guess ingredient densities or silently change the kind of salt.

Marking, planning, and shopping never rewrite recipe files. Nothing in the app writes a `## Cook Log` entry; the recipe view renders whatever entries a recipe file already carries.

## Covers

The browser stores every imported cover as two WebP files. The recipe `cover` path names the display image, capped to a 1280 px longest side. Its 448 × 448 card thumbnail is centre-cropped and stored beside it by removing the cover path's last extension and appending `.card.webp`: for example, `images/dish.jpg` and `images/dish.webp` both derive `images/dish.card.webp`. `thumbnailPathForCover` is the sole implementation of this rule. Cards use the thumbnail; recipe content uses the display image. A missing thumbnail falls back to the display image while the open-time browser backfill writes the normalized pair with an automatic transaction origin that cannot publish an unpublished cookbook.

## Planning

`Plan.md` at the cookbook root is the only planner document. It contains `## Marked` and sorted `## YYYY-MM-DD` sections. Every entry is one `- [[recipe-link]]` line. A unique filename stem is the link; duplicate stems use the folder-relative path without `.md`. Empty day sections are omitted.

## Shopping

`Shopping.md` at the cookbook root is a Markdown checklist. Browser Build list processes the displayed week's distinct recipe paths in ascending path order; `mep shop` selects recipes by date and their order in each date section. Building writes one `## <recipe title>` section per contributing recipe. Equal ingredient text is deduplicated only within that recipe block, never across recipes. Checked state and aisle carry over by trimmed, case-folded ingredient text plus the normalized recipe heading and its same-title block occurrence, so equal lines in different recipe blocks remain independent. Existing non-recipe headings and hand-written content remain unchanged. Every local shopping write canonicalizes all recognized checkbox markers to `[x]` or `[ ]`; an observed malformed concurrent marker is repaired through the cookbook adapter, and parsing remains tolerant until repair. Checking an item changes only its checkbox marker. Copying strips checkbox markers and aisle annotations without changing the file. The shopper can switch between recipe, aisle and ungrouped views without rewriting list order; that preference stays on the browser. Aisle assignments are explicit `<!-- aisle: Name -->` annotations on checklist lines, shared with the cookbook and retained on rebuild for the same block-and-text key. Unassigned items appear under Other. Reset removes all checklist items, checked or unchecked, in one live-text transaction, after confirmation; notes and recipes are untouched.

## Writes and conflicts

Live application writes transform the current shared text inside one Yjs transaction. Saving a recipe draft merges it against the current shared text, preserving overlapping changes as explicit conflict blocks.

`mep shop` hashes the file it read and, if `Shopping.md` changes before save, writes the rebuilt list to a sibling `.conflict-*.md` file instead of overwriting either version.
