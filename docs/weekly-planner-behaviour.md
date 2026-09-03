# Weekly Planner Behaviour

The planner reads and writes only `Plan.md` in the selected folder.

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

Build list selects scheduled recipes from the displayed week, ordered by date and then by their order in each date section. It rebuilds recipe-owned sections in `Shopping.md` without writing any recipe.

All planner writes use the folder adapter's hash comparison and conflict-copy rule.
