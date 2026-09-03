# Cooking Domain Contract

Enplace treats the user-selected folder as the complete cooking data store.

## Recipes

A recipe is any `.md` file anywhere below the selected folder whose body contains a level-two `## Ingredients` heading, matched case-insensitively.

- Title: frontmatter `title`, otherwise the first level-one heading, otherwise the filename stem.
- Ingredients: bullet text below `## Ingredients`, kept as opaque text. Pipe-delimited legacy lines have no special meaning.
- Method: numbered or bulleted text below `## Method`, when present.
- Cover: frontmatter `cover`, otherwise the first Markdown image in the body. Relative paths resolve from the recipe file and are read through the selected folder handle.
- Source: optional frontmatter `source`.

Marking, planning, and shopping never rewrite recipe files.

## Planning

`Plan.md` at the folder root is the only planner document. It contains `## Marked` and sorted `## YYYY-MM-DD` sections. Every entry is one `- [[recipe-link]]` line. A unique filename stem is the link; duplicate stems use the folder-relative path without `.md`. Empty day sections are omitted.

## Shopping

`Shopping.md` at the folder root is a Markdown checklist. Building a list uses the displayed week's planned recipes in plan order. It writes one `## <recipe title>` section per contributing recipe and merges equal ingredient text after trimming and case folding. Existing checked state follows surviving text. Existing non-recipe headings and hand-written content remain unchanged. Checking an item changes only its checkbox marker. Copying strips checkbox markers without changing the file.

## Writes and conflicts

Every open document retains the SHA-256 hash of the bytes read. Immediately before a write, Enplace reads and hashes the path again. If the hash differs, Enplace leaves the path untouched, writes the app version beside it as `<stem>.conflict-<YYYYMMDD-HHMMSS>.md`, and reports that path to the user. There are no locks, revisions, or rollback files.
