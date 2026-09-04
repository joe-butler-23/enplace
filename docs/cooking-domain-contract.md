# Cooking Domain Contract

The shared kitchen document is the complete cooking data authority. Paths in this contract are kitchen-relative; a folder exists only as a CLI mirror or plain-file export.

## Recipes

A recipe is any `.md` file in the kitchen whose body contains a level-two `## Ingredients` heading, matched case-insensitively.

- Title: frontmatter `title`, otherwise the first level-one heading, otherwise the filename stem.
- Ingredients: bullet text below `## Ingredients`, kept as opaque text. Pipe-delimited legacy lines have no special meaning.
- Method: numbered or bulleted text below `## Method`, when present.
- Cover: frontmatter `cover`, otherwise the first Markdown image in the body. Relative paths resolve from the recipe file and are read from the kitchen document.
- Source: optional frontmatter `source`.

Marking, planning, and shopping never rewrite recipe files. Completing a planned week appends a Cook Log entry to each completed recipe.

## Planning

`Plan.md` at the kitchen root is the only planner document. It contains `## Marked` and sorted `## YYYY-MM-DD` sections. Every entry is one `- [[recipe-link]]` line. A unique filename stem is the link; duplicate stems use the folder-relative path without `.md`. Empty day sections are omitted.

## Shopping

`Shopping.md` at the kitchen root is a Markdown checklist. Browser Build list processes the displayed week's distinct recipe paths in ascending path order; `mep shop` selects recipes by date and their order in each date section. Building writes one `## <recipe title>` section per contributing recipe and merges equal ingredient text after trimming and case folding. Existing checked state follows surviving text. Existing non-recipe headings and hand-written content remain unchanged. Checking an item changes only its checkbox marker. Copying strips checkbox markers without changing the file.

## Writes and conflicts

Live application writes transform the current shared text inside one Yjs transaction. Saving a recipe draft merges it against the current shared text, preserving overlapping changes as explicit conflict blocks. The optional filesystem mirror applies the same inline three-way merge to text. Before replacing or deleting a regular file, it stages the desired bytes and atomically moves the current inode to a final same-parent recovery name at `.mep-mirror/<private-operation>/<stem>.local-<timestamp><extension>`. The exact `.mep-mirror` component is reserved and never imported. Its directories are tightened to `0700`; the recovery inode and published replacement retain the displaced target's mode. Final `.local-*` recovery names are never removed automatically, so writes through an already-open descriptor remain recoverable. After restart reaches authoritative public convergence, the mirror removes an exact stale `replacement` staging file only when its bytes match the public file; ambiguous staging remains untouched. Review a recovered file and copy it back deliberately when it contains a wanted local version.

Publication and restoration use no-clobber hard links. If a concurrent regular writer creates the public path, the mirror rereads and retries without overwriting it. If an ordinary race replaces an expected file with a non-regular path before the atomic move, Node cannot provide a type-conditional rename; the mirror stops and reports the final recovery name instead of hiding it in temporary state. A resolved filesystem root is rejected before relay connection or traversal. Protection assumes another process with the same user identity does not swap already-validated directory ancestors for symlinks between checks. At cold start and with `--once`, local-only files remain accepted inputs; after a write is accepted, the shared `Y.Doc` is authoritative for that live mirror session. `mep shop` hashes the file it read and, if `Shopping.md` changes before save, writes the rebuilt list to a sibling `.conflict-*.md` file instead of overwriting either version.
