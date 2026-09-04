# Weekly Planner Behaviour

Planning and marking read and write `Plan.md` in the shared kitchen document. Build list writes `Shopping.md`. Complete Week appends Cook Log entries to the scheduled recipe files.

## Marked recipes

Marking a recipe adds its wikilink under `## Marked`. Unmarking removes it. Recipe frontmatter is never changed.

## Week

The planner displays Monday through Sunday. Scheduling adds the recipe wikilink under that day's `## YYYY-MM-DD` heading. A recipe can appear on more than one day. Removing the last entry removes the empty day heading.

`Plan.md` stays stable and readable:

- `## Marked` comes first.
- Date headings are sorted.
- Entries retain their plan order and occur once per section.
- Empty days and unrelated content are not written.
- Unique recipe stems use `[[stem]]`; colliding stems use `[[folder/path/stem]]`.

## Shopping hand-off

Build list selects the distinct scheduled recipe paths from the displayed week and currently processes them in ascending path order. It rebuilds recipe-owned sections in `Shopping.md` without writing any recipe.

Each planner write transforms the relevant shared kitchen text inside one Yjs transaction. Marking and scheduling change only `Plan.md`; Complete Week appends one Cook Log entry to each completed recipe.
